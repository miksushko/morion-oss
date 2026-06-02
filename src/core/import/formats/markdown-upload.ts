import { extname } from 'node:path';
import type { ImportEntry, ImportEntryFile, ImportEntryFolder } from '../types.js';
import {
  convertDocxToMarkdown,
  DocxLegacyDocError,
  DocxPasswordError,
  DocxTooLargeError,
} from './docx.js';

/**
 * Markdown scanner for in-memory file uploads.
 *
 * The fs-based scanner walks a directory on disk; this variant
 * builds the same `ImportEntry` shape from a list of files the user
 * already picked via a browser file input. Bytes come pre-loaded;
 * the engine's `preReadBytes` field is populated so it doesn't try
 * to read from disk.
 *
 * `relPath` for folder uploads is the browser's
 * `File.webkitRelativePath` (forward-slash separated, e.g.
 * `MyVault/Projects/foo.md`). For single-file uploads it's just the
 * filename. We derive the `sourceRootName` (top-level Morion folder)
 * from the first segment of the first file's relPath, since
 * `webkitdirectory` enforces all selected files share the same root.
 */

const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.docx']);
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const DOCX_EXTENSIONS = new Set(['.docx']);

export interface UploadedFile {
  /** Forward-slash relative path. For folder uploads this is the
   *  browser's `webkitRelativePath`. For single files it's just the
   *  filename. */
  relPath: string;
  /** UTF-8 string for text files (.md / .txt) — server reads it as
   *  the note body verbatim. For binary files (.docx) the bytes
   *  arrive base64-encoded in this field; the server detects format
   *  via extension and decodes appropriately. */
  bytes: string;
  /** Optional encoding hint. Default: `text` for .md/.txt;
   *  `base64` for .docx. */
  encoding?: 'text' | 'base64';
}

export interface ProcessedUploadFile {
  /** Plain markdown body ready for the engine's processScan. */
  markdown: string;
  /** Inline images extracted from this file (.docx only currently).
   *  Engine writes bytes + creates attachment rows after note insert,
   *  then rewrites placeholders. */
  images: Array<{ placeholder: string; mimeType: string; bytes: Buffer }>;
  /** Per-file warnings to surface in the import summary. */
  warnings: string[];
}

export interface UploadScanResult {
  sourceRootName: string | null;
  entries: ImportEntry[];
  /** Map of source-file relPath → inline images extracted during
   *  conversion. Engine writes bytes + creates attachment rows after
   *  the note insert, then swaps the placeholder srcs in the body.
   *  Undefined when no images were extracted across the whole batch. */
  perFileImages?: Map<
    string,
    Array<{ placeholder: string; mimeType: string; bytes: Buffer }>
  >;
  /** Map of source-file relPath → per-file warnings (mammoth style
   *  messages, unsupported features). Undefined when none. */
  perFileWarnings?: Map<string, string[]>;
}

/**
 * Build entries from a single uploaded file.
 *
 * Single file mode: no top-level folder created in Morion (lands at
 * the unfiled root). The relPath is just the filename.
 *
 * Async because .docx files require mammoth conversion BEFORE we can
 * embed the body in `preReadBytes`.
 */
export async function scanUploadedFile(file: UploadedFile): Promise<UploadScanResult> {
  validateExtension(file.relPath);
  const processed = await processFileContent(file);
  const entry: ImportEntryFile = {
    kind: 'file',
    sourcePath: file.relPath,
    relPath: file.relPath,
    preReadBytes: processed.markdown,
    parentRelPath: null,
  };
  return {
    sourceRootName: null,
    entries: [entry],
    perFileImages: processed.images.length > 0
      ? new Map([[file.relPath, processed.images]])
      : undefined,
    perFileWarnings: processed.warnings.length > 0
      ? new Map([[file.relPath, processed.warnings]])
      : undefined,
  };
}

/**
 * Build entries from a list of uploaded files preserving the
 * directory structure encoded in their relPaths.
 *
 * Strips the top-level segment (the source folder name) from each
 * relPath and returns it as `sourceRootName` so the engine creates
 * the corresponding top-level Morion folder.
 *
 * Order:
 *   1. Synthetic root folder entry (`relPath = ''`)
 *   2. All subfolders (parent before child, alphabetical inside each
 *      level)
 *   3. All files
 *
 * The folder list is derived from the union of every file's parent
 * dirs. Empty subfolders aren't preserved (browsers don't return
 * empty dirs from `webkitdirectory` anyway).
 */
export async function scanUploadedFolder(files: UploadedFile[]): Promise<UploadScanResult> {
  if (files.length === 0) {
    throw new Error('Folder upload contained no markdown files.');
  }

  // Filter to supported extensions; skip silently (matches fs scanner).
  const supported = files.filter((f) =>
    SUPPORTED_EXTENSIONS.has(extname(f.relPath).toLowerCase()),
  );
  if (supported.length === 0) {
    throw new Error(
      'Folder contained no .md / .markdown / .txt files. Pick a folder with markdown notes.',
    );
  }

  // Derive sourceRootName from the first segment. webkitdirectory
  // guarantees all files share this prefix.
  const firstSegments = new Set<string>();
  for (const f of supported) {
    const seg = f.relPath.split('/')[0];
    if (seg) firstSegments.add(seg);
  }
  if (firstSegments.size !== 1) {
    // Defensive — shouldn't happen with webkitdirectory but be safe.
    throw new Error(
      `Expected files to share a single top-level folder; got ${firstSegments.size} different roots.`,
    );
  }
  const sourceRootName = [...firstSegments][0]!;

  // Strip the top-level segment from each file's relPath so the
  // engine resolves them under the new Morion folder. Convert each
  // file's content (.docx → markdown via mammoth, others verbatim).
  const perFileImages = new Map<
    string,
    Array<{ placeholder: string; mimeType: string; bytes: Buffer }>
  >();
  const perFileWarnings = new Map<string, string[]>();
  const stripped: Array<{ rel: string; bytes: string; original: string }> = [];
  for (const f of supported) {
    const idx = f.relPath.indexOf('/');
    const rel = idx === -1 ? f.relPath : f.relPath.slice(idx + 1);
    let processed: ProcessedUploadFile;
    try {
      processed = await processFileContent(f);
    } catch (err) {
      // Surface as a per-file warning so the engine emits an error
      // event for it but the rest of the folder still imports.
      perFileWarnings.set(f.relPath, [(err as Error).message]);
      continue;
    }
    if (processed.images.length > 0) perFileImages.set(f.relPath, processed.images);
    if (processed.warnings.length > 0) perFileWarnings.set(f.relPath, processed.warnings);
    stripped.push({ rel, bytes: processed.markdown, original: f.relPath });
  }
  if (stripped.length === 0) {
    throw new Error(
      'Folder contained no successfully-converted files. Check warnings.',
    );
  }

  // Collect every parent directory across the stripped relPaths.
  const folderRels = new Set<string>();
  folderRels.add(''); // synthetic root
  for (const f of stripped) {
    const segments = f.rel.split('/');
    let walked = '';
    for (let i = 0; i < segments.length - 1; i++) {
      walked = walked === '' ? segments[i]! : `${walked}/${segments[i]!}`;
      folderRels.add(walked);
    }
  }

  const entries: ImportEntry[] = [];
  // Folders parent-before-child via depth-then-alpha sort.
  const sortedFolders = [...folderRels].sort((a, b) => {
    const da = a === '' ? 0 : a.split('/').length;
    const db = b === '' ? 0 : b.split('/').length;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
  for (const rel of sortedFolders) {
    entries.push({
      kind: 'folder',
      sourcePath: `<upload>${rel ? '/' + rel : ''}`,
      relPath: rel,
    } satisfies ImportEntryFolder);
  }
  // Files sorted alphabetically by relPath.
  const sortedFiles = stripped.sort((a, b) => a.rel.localeCompare(b.rel));
  for (const f of sortedFiles) {
    const segments = f.rel.split('/');
    const parentRelPath =
      segments.length > 1 ? segments.slice(0, -1).join('/') : '';
    entries.push({
      kind: 'file',
      sourcePath: f.original,
      relPath: f.rel,
      preReadBytes: f.bytes,
      parentRelPath,
    } satisfies ImportEntryFile);
  }

  return {
    sourceRootName,
    entries,
    perFileImages: perFileImages.size > 0 ? perFileImages : undefined,
    perFileWarnings: perFileWarnings.size > 0 ? perFileWarnings : undefined,
  };
}

/**
 * Convert one uploaded file's payload into the engine's expected
 * markdown body. For text files (`.md` / `.markdown` / `.txt`)
 * that's the raw bytes (UTF-8 string). For `.docx` we run the
 * mammoth conversion + image extraction.
 */
async function processFileContent(file: UploadedFile): Promise<ProcessedUploadFile> {
  const ext = extname(file.relPath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return { markdown: file.bytes, images: [], warnings: [] };
  }
  if (DOCX_EXTENSIONS.has(ext)) {
    const buf = file.encoding === 'base64'
      ? Buffer.from(file.bytes, 'base64')
      : Buffer.from(file.bytes, 'binary');
    try {
      const result = await convertDocxToMarkdown(buf);
      return {
        markdown: result.markdown,
        images: result.images.map((img) => ({
          placeholder: `data-mammoth-image:${img.index}`,
          mimeType: img.mimeType,
          bytes: img.bytes,
        })),
        warnings: result.warnings,
      };
    } catch (err) {
      if (
        err instanceof DocxLegacyDocError ||
        err instanceof DocxPasswordError ||
        err instanceof DocxTooLargeError
      ) {
        throw err;
      }
      throw new Error(`.docx conversion failed: ${(err as Error).message}`);
    }
  }
  throw new Error(`Unsupported extension at processFileContent: ${ext}`);
}

function validateExtension(filename: string): void {
  const ext = extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported file extension: ${ext} (expected .md / .markdown / .txt)`,
    );
  }
}

/** Test-only re-export. */
export const __test = { SUPPORTED_EXTENSIONS };

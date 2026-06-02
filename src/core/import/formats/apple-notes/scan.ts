import type { ImportEntry, ImportEntryFile, ImportEntryFolder } from '../../types.js';
import type { AppleNotesExportResult, AppleNotesNote } from './types.js';
import { extractInlineImages } from './images.js';
import { htmlToMarkdown } from './html-to-md.js';

export interface AppleNotesScanResult {
  /** Always `null` — Apple Notes imports do NOT create a wrapper
   *  folder. Picked folders land directly at root by their leaf name
   *  only (no `iCloud/` or `Projects/` prefix), matching what the
   *  user picked in the folder-tree dialog (ticket
   *  `01KQFG3MEY8K9PZ8KSW7QH6BAF` — both wrapper variants ship
   *  unwanted parent folders). */
  sourceRootName: null;
  entries: ImportEntry[];
  /** Notes that failed HTML-to-markdown conversion (informational). */
  conversionWarnings: Array<{ name: string; message: string }>;
  /** Map of source-file relPath → inline images extracted from the
   *  note's HTML body. Engine writes bytes + creates attachment rows
   *  after the note insert, then swaps the placeholder srcs in the
   *  body for `morion://attachment/<id>` URLs. Same shape +
   *  finaliseUploadImages call site as docx upload. Undefined when
   *  no images were extracted across the whole batch. */
  perFileImages?: Map<
    string,
    Array<{ placeholder: string; mimeType: string; bytes: Buffer }>
  >;
}

/**
 * Convert an `AppleNotesExportResult` into the engine's standard
 * `ImportEntry` list. Each picked Apple Notes folder lands at
 * Morion's root by its leaf name — no `iCloud/` account wrapper, no
 * `Projects/` intermediate path. If the user picked a nested folder
 * "iCloud/Projects/Foo", it appears at root as just "Foo".
 *
 * Two picks ending in the same leaf name (e.g. `iCloud/Personal/Foo`
 * + `On My Mac/Personal/Foo`) merge into one Morion folder via the
 * inside-import `getOrCreate` rule. Acceptable because Apple Notes'
 * folder picker shows the path as breadcrumbs anyway — the user
 * already knows they're picking "Foo", not the parent chain.
 *
 * The engine's `processScan` flow then handles folder creation,
 * duplicate titles, sanitisation, etc. — same code path as fs +
 * upload imports.
 */
export function scanAppleNotesExport(result: AppleNotesExportResult): AppleNotesScanResult {
  const conversionWarnings: Array<{ name: string; message: string }> = [];
  const sourceRootName = null;

  // Per-note destination folder = the LAST segment of folderPath
  // (the picked folder's own name). We deliberately drop both the
  // account name and any intermediate path segments — the user
  // picked the folder by its leaf identity, not by its position in
  // the Apple Notes tree.
  const leafFolderName = (note: AppleNotesNote): string => {
    const segments = note.folderPath
      .split('/')
      .map(sanitiseSegment)
      .filter((s) => s.length > 0);
    return segments[segments.length - 1] ?? sanitiseSegment(note.accountName) ?? 'Apple Notes';
  };

  // Collect every distinct leaf folder name we'll need to create.
  const folderRels = new Set<string>();
  folderRels.add(''); // synthetic root entry — engine's processScan filters this out
  for (const note of result.notes) {
    folderRels.add(leafFolderName(note));
  }

  // Parent-before-child ordering — trivial here since every folder
  // is one level deep, but we keep the sort for entry-array shape
  // compatibility with the engine's processScan expectations.
  const sortedFolders = [...folderRels].sort((a, b) => {
    const da = a === '' ? 0 : 1;
    const db = b === '' ? 0 : 1;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });

  const entries: ImportEntry[] = [];
  for (const rel of sortedFolders) {
    entries.push({
      kind: 'folder',
      sourcePath: `<apple-notes>${rel ? '/' + rel : ''}`,
      relPath: rel,
    } satisfies ImportEntryFolder);
  }

  // File entries — one per note. preReadBytes is the markdown-converted body.
  let imageCounter = 0;
  const perFileImages = new Map<
    string,
    Array<{ placeholder: string; mimeType: string; bytes: Buffer }>
  >();
  for (const note of result.notes) {
    // Extract inline `data:` images BEFORE turndown so multi-MB
    // base64 blobs don't end up in the note body. PNG/JPEG/GIF/WebP
    // become Morion attachments via finaliseUploadImages post-import;
    // unsupported types (TIFF/HEIC) are stripped with a counter that
    // surfaces as one per-note warning.
    const extracted = extractInlineImages(note.bodyHtml, imageCounter);
    imageCounter += extracted.images.length;
    if (extracted.strippedCount > 0) {
      conversionWarnings.push({
        name: note.name,
        message: `${extracted.strippedCount} inline image(s) stripped (unsupported format — only PNG / JPEG / GIF / WebP are imported as attachments).`,
      });
    }
    let markdown: string;
    try {
      markdown = htmlToMarkdown(extracted.cleanedHtml);
    } catch (err) {
      conversionWarnings.push({
        name: note.name,
        message: `HTML→markdown failed: ${(err as Error).message}`,
      });
      markdown = extracted.cleanedHtml; // fall back to cleaned HTML; sanitiser will strip tags
    }
    const parentRelPath = leafFolderName(note);
    const titleSafe = sanitiseSegment(note.name) || 'Untitled';
    const relPath = `${parentRelPath}/${titleSafe}.md`;
    // Stash extracted images keyed by the file's relPath so the
    // engine's finaliseUploadImages can locate the right note
    // post-import (it searches notes whose body contains the
    // placeholder, but multiple notes can share a folder so the
    // map shape matches docx upload's contract).
    if (extracted.images.length > 0) {
      perFileImages.set(relPath, extracted.images);
    }
    // Body for the engine includes the title as H1 (already a Phase 1
    // contract — engine ensureTitlePrefix handles this). We just
    // pass the body; engine will derive title from the H1 or fall
    // back to filename. To force the title, we can prepend it now.
    const body = markdown.startsWith('# ')
      ? markdown
      : `# ${note.name}\n\n${markdown}`;
    entries.push({
      kind: 'file',
      sourcePath: `<apple-notes>/${relPath}`,
      relPath,
      preReadBytes: body,
      parentRelPath,
    } satisfies ImportEntryFile);
  }

  return {
    sourceRootName,
    entries,
    conversionWarnings,
    perFileImages: perFileImages.size > 0 ? perFileImages : undefined,
  };
}

/** Apple Notes folder / note names can contain slashes, colons,
 *  unicode quirks. Strip path separators so we don't accidentally
 *  build phantom subfolders, but keep most other punctuation. */
function sanitiseSegment(name: string): string {
  return name.replace(/\//g, ' ').replace(/\\/g, ' ').trim();
}

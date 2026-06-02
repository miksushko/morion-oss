import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import type { ImportEntry, ImportEntryFile, ImportEntryFolder } from '../types.js';

/**
 * Markdown format scanner — Phase 1.
 *
 * Walks a directory tree (or accepts a single file) and emits the
 * ordered list of `ImportEntry` items the engine needs to drive its
 * batch queue. Folders come BEFORE the files inside them so the
 * engine can create the Morion folder row before any child file
 * tries to insert against it.
 *
 * Phase 1 supports `.md`, `.markdown`, `.txt`. Frontmatter is NOT
 * parsed here — Phase 2 adds gray-matter / YAML extraction. The body
 * stored in Morion is the file contents verbatim. Files starting
 * with `.` are skipped (hidden / `.DS_Store`).
 */

const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

export interface MarkdownScanResult {
  /** Top-level source folder name; null when scanning a single file. */
  sourceRootName: string | null;
  /** Ordered entries: folders first (parent → child), then their files. */
  entries: ImportEntry[];
}

/**
 * Scan a single file for import. Returns one `file`-kind entry with
 * `parentRelPath = null` so it lands at Morion root.
 */
export function scanMarkdownFile(absPath: string): MarkdownScanResult {
  const ext = extname(absPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported file extension: ${ext} (expected .md / .markdown / .txt)`);
  }
  const stat = statSync(absPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${absPath}`);
  }
  const entry: ImportEntryFile = {
    kind: 'file',
    sourcePath: absPath,
    relPath: basename(absPath),
    preReadBytes: null,
    parentRelPath: null,
  };
  return {
    sourceRootName: null,
    entries: [entry],
  };
}

/**
 * Recursively scan a folder. Returns folder-kind entries (parent before
 * child) followed by file-kind entries.
 *
 * `relPath` on entries is the path UNDER the import root (using `/`
 * separators on all platforms — we normalise here so the queue's
 * cache keys match across folder + file entries even when the OS uses
 * a different path separator).
 *
 * The root folder itself is emitted as a folder-kind entry with
 * `relPath=''` so the engine knows to create the top-level Morion
 * folder before processing anything inside.
 */
export function scanMarkdownFolder(absRootPath: string): MarkdownScanResult {
  const stat = statSync(absRootPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${absRootPath}`);
  }

  const sourceRootName = basename(absRootPath);
  const entries: ImportEntry[] = [];

  // Root folder entry — empty relPath signals "the import root itself".
  entries.push({
    kind: 'folder',
    sourcePath: absRootPath,
    relPath: '',
  });

  // BFS so folders enqueue in topological order (parents before children).
  // Files within a single folder go after that folder's entry but before
  // any sibling folders' children — natural BFS does this correctly.
  const queue: string[] = [absRootPath];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let dirEntries: string[];
    try {
      dirEntries = readdirSync(current).sort();
    } catch (err) {
      throw new Error(
        `Failed to read directory ${current}: ${(err as Error).message}`,
      );
    }

    const subDirs: string[] = [];
    const files: string[] = [];
    for (const name of dirEntries) {
      if (name.startsWith('.')) continue; // skip hidden + .DS_Store etc.
      const full = join(current, name);
      let entryStat;
      try {
        entryStat = statSync(full);
      } catch {
        continue; // broken symlink, permission denied, etc.
      }
      if (entryStat.isDirectory()) {
        subDirs.push(full);
      } else if (
        entryStat.isFile() &&
        SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase())
      ) {
        files.push(full);
      }
    }

    // Emit folder entries for this level's subdirs (so they exist before
    // any of their children get processed).
    for (const sub of subDirs) {
      const rel = normaliseRelPath(relative(absRootPath, sub));
      entries.push({
        kind: 'folder',
        sourcePath: sub,
        relPath: rel,
      } satisfies ImportEntryFolder);
    }

    // Emit file entries for this level's files. parentRelPath is the
    // current folder's relPath under the import root.
    const currentRel = current === absRootPath ? '' : normaliseRelPath(relative(absRootPath, current));
    for (const file of files) {
      const rel = normaliseRelPath(relative(absRootPath, file));
      entries.push({
        kind: 'file',
        sourcePath: file,
        relPath: rel,
        preReadBytes: null,
        parentRelPath: currentRel,
      } satisfies ImportEntryFile);
    }

    // Recurse into subdirs.
    queue.push(...subDirs);
  }

  return {
    sourceRootName,
    entries,
  };
}

/** Read the file body lazily — separate so the engine can defer I/O until
 *  the queue actually claims this entry. */
export function readMarkdownBody(absPath: string): string {
  return readFileSync(absPath, 'utf8');
}

/**
 * Derive a note title from the file. Priority:
 *   1. First H1 (`# Title`) inside the body, if it's the first non-blank line.
 *   2. Filename stem (no extension).
 *
 * Frontmatter title extraction is Phase 2 — Phase 1 doesn't parse YAML.
 */
export function deriveTitle(absPath: string, body: string): string {
  const firstNonBlank = body
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  if (firstNonBlank && /^#\s+.+/.test(firstNonBlank.trim())) {
    return firstNonBlank.trim().replace(/^#\s+/, '').trim();
  }
  return basename(absPath, extname(absPath));
}

/** Normalise to forward-slashes so queue cache keys match across platforms. */
function normaliseRelPath(p: string): string {
  return p.split(sep).join('/');
}

/** Test-only re-export. */
export const __test = { SUPPORTED_EXTENSIONS, normaliseRelPath };

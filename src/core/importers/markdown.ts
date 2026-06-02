import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, relative, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import type { FoldersRepository } from '../folders/repository.js';
import type { NotesRepository } from '../notes/repository.js';
import type { Indexer } from '../search/indexer.js';

export interface ImportOptions {
  /** Absolute path to the vault root. Files at the root land in Inbox (no folder). */
  vaultPath: string;
  /** Source string written to `notes.source`. Default: `import:markdown`. */
  source?: string;
}

export interface ImportSummary {
  scanned: number;
  imported: number;
  skipped: number;
  errors: { file: string; error: string }[];
}

interface ParsedFile {
  /** Absolute filesystem path. */
  absPath: string;
  /** Path relative to vaultPath. */
  relPath: string;
  title: string;
  body: string;
  tags: string[];
  /** First path segment under the vault root, or null if file sits at root. */
  folderName: string | null;
}

/**
 * Walks a directory of markdown files and imports them into Morion.
 *
 * Conventions:
 * - One folder level: the first path segment under the vault root becomes the
 *   folder name. Files directly at the root land in Inbox (folder = null).
 *   Deeply nested files collapse to their top-level segment. Nested folders
 *   are a v0.2 concern.
 * - Title comes from `frontmatter.title` if present, otherwise the filename
 *   stem (kebab/snake case is preserved verbatim — no auto-titlecase).
 * - Tags come from `frontmatter.tags` (array or comma-separated string).
 * - Dedupe is by sha256 of `title\0body`. We preload all existing non-deleted
 *   notes once at the start and skip any file whose hash already exists. This
 *   makes re-running the importer safe and idempotent in the common case.
 * - Body is the markdown after frontmatter is stripped. Frontmatter is dropped
 *   from the stored body to keep the editor view clean; tags survive via the
 *   tags column instead.
 */
export class MarkdownImporter {
  constructor(
    private readonly notes: NotesRepository,
    private readonly folders: FoldersRepository,
    private readonly indexer: Indexer,
  ) {}

  async import(options: ImportOptions): Promise<ImportSummary> {
    const root = resolve(options.vaultPath);
    const source = options.source ?? 'import:markdown';

    const summary: ImportSummary = { scanned: 0, imported: 0, skipped: 0, errors: [] };

    const files = walkMarkdown(root);
    summary.scanned = files.length;

    const existing = this.preloadExistingHashes();

    for (const absPath of files) {
      try {
        const parsed = parseFile(absPath, root);
        // Build the merged body that the repo will produce (title prepended if needed)
        const mergedBody = parsed.body.trimStart().startsWith(parsed.title)
          ? parsed.body
          : parsed.body.trim()
            ? `# ${parsed.title}\n\n${parsed.body}`
            : parsed.title;
        const hash = hashNote(mergedBody);
        if (existing.has(hash)) {
          summary.skipped += 1;
          continue;
        }

        const folderId = parsed.folderName
          ? this.folders.getOrCreate(parsed.folderName).id
          : null;

        const note = this.notes.create(
          {
            title: parsed.title,
            body: parsed.body,
            folderId,
            tags: parsed.tags,
            source,
          },
          source,
        );

        existing.add(hash);
        await this.indexer.reindex(note);
        summary.imported += 1;
      } catch (err) {
        summary.errors.push({
          file: absPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return summary;
  }

  /**
   * Pull `(title, body)` for every live note and build a hash set. O(N) at
   * import start, O(1) per file thereafter. For vaults of any reasonable size
   * this is far cheaper than per-file SQL lookups.
   */
  private preloadExistingHashes(): Set<string> {
    const all = this.notes.list({ limit: 500, offset: 0 });
    const hashes = new Set<string>();
    let offset = 0;
    let batch = all;
    while (batch.length > 0) {
      for (const note of batch) hashes.add(hashNote(note.body));
      if (batch.length < 500) break;
      offset += 500;
      batch = this.notes.list({ limit: 500, offset });
    }
    return hashes;
  }
}

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = `${current}${sep}${entry}`;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile() && extname(entry).toLowerCase() === '.md') {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function parseFile(absPath: string, root: string): ParsedFile {
  const raw = readFileSync(absPath, 'utf8');
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;

  const title = typeof data.title === 'string' && data.title.trim().length > 0
    ? data.title.trim()
    : basename(absPath, extname(absPath));

  const tags = normalizeTags(data.tags);

  const relPath = relative(root, absPath);
  const segments = relPath.split(sep);
  const folderName = segments.length > 1 ? segments[0]! : null;

  return {
    absPath,
    relPath,
    title,
    body: parsed.content.trimStart(),
    tags,
    folderName,
  };
}

function normalizeTags(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  if (typeof input === 'string') {
    return input
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return [];
}

function hashNote(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** Re-exported for tests that want to assert dedupe behaviour directly. */
export const __test = { hashNote, parseFile, walkMarkdown, normalizeTags };

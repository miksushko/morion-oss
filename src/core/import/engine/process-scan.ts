/**
 * Core import pipeline — turns a format-agnostic `ImportScan` into
 * notes + folders + attachments + progress/error events. Extracted
 * from `../engine.ts` so the engine shell stays focused on per-format
 * dispatch + lifecycle.
 *
 * Stateless function operating on an injected `ProcessScanContext`
 * that bundles the engine's repositories + per-batch knobs. The
 * engine passes `() => this.cancelled` and `(ev) => this.emit(ev)` so
 * cancellation + event emission keep flowing through the engine's
 * EventEmitter.
 */

import { ulid } from 'ulid';
import type { AttachmentsRepository } from '../../attachments/repository.js';
import type { FoldersRepository } from '../../folders/repository.js';
import type { NotesRepository } from '../../notes/repository.js';
import { processInlineAttachments, finaliseAttachments } from '../attachments.js';
import { FolderResolver } from '../folder-resolver.js';
import { readMarkdownBody, deriveTitle } from '../formats/markdown.js';
import { parseFrontmatter } from '../frontmatter.js';
import { sanitiseImportedHtml } from '../sanitize.js';
import type {
  ImportEntry,
  ImportEntryFile,
  ImportEvent,
  ImportSource,
  ImportSummary,
} from '../types.js';
import { countWords, ensureTitlePrefix, runWithConcurrency } from './helpers.js';

/**
 * Hard cap on imported note body length, in words. Imports
 * exceeding this fail with a clean error rather than landing as
 * monster notes that bog down the editor + search index. Author
 * manuscripts and other long-form writing belong in a different tool;
 * Morion is a notebook, not a Scrivener replacement. Split-by-chapter
 * is left to the user to do manually before re-importing.
 *
 * Words are counted by whitespace split — fast, language-agnostic
 * (works for Russian + English the same way), and forgiving on
 * markdown punctuation. 20k words ≈ a typical novel chapter or a
 * long technical doc; comfortably above any single note's natural
 * scope.
 */
export const MAX_BODY_LENGTH_WORDS = 20_000;

export interface ProcessScanContext {
  notes: NotesRepository;
  folders: FoldersRepository;
  attachments: AttachmentsRepository | null;
  configDir: string | null;
  actor: string;
  batchId: string;
  source: ImportSource;
  fileConcurrency: number;
  isCancelled: () => boolean;
  emit: (event: ImportEvent) => void;
}

export async function processScan(
  ctx: ProcessScanContext,
  scan: { sourceRootName: string | null; entries: ImportEntry[] },
  importRoot: string,
): Promise<ImportSummary> {
  const fileEntries = scan.entries.filter(
    (e): e is ImportEntryFile => e.kind === 'file',
  );
  const total = fileEntries.length;

  ctx.emit({ type: 'start', batchId: ctx.batchId, total });

  // Phase A — create the import root folder (sync, single insert).
  const resolver = new FolderResolver(ctx.folders);
  const rootFolderId = resolver.createImportRoot(scan.sourceRootName);

  // Phase B — create subfolders sequentially (parent before child).
  // Skipping the synthetic root entry (already created above).
  const subfolderEntries = scan.entries.filter(
    (e) => e.kind === 'folder' && e.relPath !== '',
  );
  for (const folder of subfolderEntries) {
    if (ctx.isCancelled()) break;
    // FolderResolver caches by relPath; calling resolveForRelPath on
    // the folder's own relPath ensures it's created.
    try {
      resolver.resolveForRelPath(folder.relPath);
    } catch (err) {
      // Folder creation is rare to fail (just a SQL insert) — log and
      // continue; child files in this folder will fail individually
      // when resolveForRelPath retries and propagates.
      ctx.emit({
        type: 'error',
        batchId: ctx.batchId,
        error: {
          file: folder.sourcePath,
          message: `Failed to create folder: ${(err as Error).message}`,
        },
      });
    }
  }

  // Phase C — drain files with bounded concurrency.
  const errors: Array<{ file: string; message: string }> = [];
  let done = 0;
  let errored = 0;

  const processOne = async (entry: ImportEntryFile): Promise<void> => {
    if (ctx.isCancelled()) return;
    try {
      const rawBody = entry.preReadBytes ?? readMarkdownBody(entry.sourcePath);

      // Phase 2: parse + strip frontmatter (gracefully degrades on
      // malformed YAML — body returned verbatim).
      const fm = parseFrontmatter(rawBody);
      let body = fm.body;
      const fmTags = fm.tags;
      const fmCreatedAt = fm.createdAt;

      // Phase 2: HTML sanitisation. Strip <script> / <iframe> /
      // event-handler attrs / javascript: URIs / CSS expressions.
      // Tiptap's html:false is the primary defence; this is defence-
      // in-depth at ingest time.
      const sanitised = sanitiseImportedHtml(body);
      body = sanitised.body;

      // Phase 2: image attachments next to the .md. Resolve image
      // refs, copy bytes to attachment store, rewrite refs to
      // morion:// URLs. SQL row insert deferred until we have the
      // owning note id (right after notes.create below).
      let pendingAttachments: Awaited<
        ReturnType<typeof processInlineAttachments>
      >['pending'] = [];
      const attachmentWarnings: Array<{ file: string; message: string }> = [];
      if (ctx.attachments && ctx.configDir) {
        const result = await processInlineAttachments({
          body,
          sourceMdPath: entry.sourcePath,
          importRoot,
          configDir: ctx.configDir,
        });
        body = result.body;
        pendingAttachments = result.pending;
        attachmentWarnings.push(...result.warnings);
      }

      // Hard cap: 20k words per imported note. Bigger ones bog
      // down the editor / search / WAL replication for the typical
      // user. Reject with a clean error so the user can split the
      // source document into chapters before re-importing.
      const wordCount = countWords(body);
      if (wordCount > MAX_BODY_LENGTH_WORDS) {
        throw new Error(
          `Note body is ${wordCount.toLocaleString()} words, exceeds the ${MAX_BODY_LENGTH_WORDS.toLocaleString()}-word import cap. Split the source document into smaller files (e.g. one chapter per file) and re-import.`,
        );
      }

      // Title resolution priority (Phase 2):
      //   1. Frontmatter `title` field
      //   2. First H1 in body (Phase 1 fallback)
      //   3. Filename stem
      const title = fm.title ?? deriveTitle(entry.sourcePath, body);

      const folderId =
        entry.parentRelPath === null
          ? null
          : resolver.resolveForRelPath(entry.parentRelPath);
      // Duplicate title handling — append (2), (3), ... until free.
      const safeTitle = findFreeTitle(ctx.notes, title, folderId);
      // Body: ensure the title is reflected as the first H1 if it's not
      // already there (so the editor's first-line-as-title contract holds).
      const bodyWithTitle = ensureTitlePrefix(body, safeTitle);

      const note = ctx.notes.create(
        {
          body: bodyWithTitle,
          folderId,
          source: ctx.source,
          status: 'note',
          tags: fmTags.length > 0 ? fmTags : undefined,
        },
        ctx.actor,
      );

      // Phase 2: finalise attachment SQL rows now that note id exists.
      if (ctx.attachments && pendingAttachments.length > 0) {
        finaliseAttachments(note.id, pendingAttachments, ctx.attachments);
      }

      // Phase 2: override created_at if frontmatter provided one.
      // We do this AFTER notes.create because the repo doesn't yet
      // accept a created_at param — direct UPDATE on the row, no
      // audit (it's a metadata write, not a content change).
      if (fmCreatedAt !== null && fmCreatedAt > 0) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const db = (ctx.notes as unknown as { db: any }).db;
          if (db) {
            db.prepare('UPDATE notes SET created_at = ? WHERE id = ?').run(
              fmCreatedAt,
              note.id,
            );
          }
        } catch {
          // Best-effort — not having the override won't break the import.
        }
      }

      // Surface attachment warnings as per-file errors so the UI
      // shows them in the final summary.
      for (const w of attachmentWarnings) {
        errored++;
        errors.push({
          file: `${entry.sourcePath}#${w.file}`,
          message: w.message,
        });
        ctx.emit({
          type: 'error',
          batchId: ctx.batchId,
          done,
          total,
          errored,
          error: {
            file: `${entry.sourcePath}#${w.file}`,
            message: w.message,
          },
        });
      }

      done++;
      ctx.emit({
        type: 'progress',
        batchId: ctx.batchId,
        done,
        total,
        errored,
        file: {
          sourceFile: entry.sourcePath,
          noteId: note.id,
          folderId,
        },
      });
    } catch (err) {
      errored++;
      const message = (err as Error).message ?? 'unknown error';
      errors.push({ file: entry.sourcePath, message });
      ctx.emit({
        type: 'error',
        batchId: ctx.batchId,
        done,
        total,
        errored,
        error: { file: entry.sourcePath, message },
      });
    }
  };

  await runWithConcurrency(
    fileEntries,
    ctx.fileConcurrency,
    processOne,
    ctx.isCancelled,
  );

  const summary: ImportSummary = {
    batchId: ctx.batchId,
    source: ctx.source,
    total,
    imported: done,
    errored,
    cancelled: ctx.isCancelled(),
    rootFolderId,
    errors,
  };

  ctx.emit({
    type: ctx.isCancelled() ? 'cancelled' : 'complete',
    batchId: ctx.batchId,
    done,
    total,
    errored,
    summary,
  });

  return summary;
}

/**
 * Find a free note title within the destination folder. If `title`
 * already exists, try `title (2)`, `title (3)`, ... up to a hard
 * cap. The check is cheap (one SQL row count per attempt).
 */
function findFreeTitle(
  notes: NotesRepository,
  baseTitle: string,
  folderId: string | null,
): string {
  const trimmed = baseTitle.trim() || 'Untitled';
  let attempt = trimmed;
  let n = 2;
  while (titleExists(notes, attempt, folderId)) {
    attempt = `${trimmed} (${n})`;
    n++;
    if (n > 1000) {
      // Safety bail-out — this would indicate a bug or an absurd folder.
      return `${trimmed} (${ulid().slice(-6)})`;
    }
  }
  return attempt;
}

function titleExists(
  notes: NotesRepository,
  title: string,
  folderId: string | null,
): boolean {
  // We can't easily query by computed title without scanning; the
  // schema has a `title` column populated by the repo on insert. Use
  // `notes.list` filter and compare titles in JS — cheap for typical
  // folder sizes (<10k notes). For perf-critical paths this could be
  // a dedicated SQL query, but Phase 1 imports rarely fight tens of
  // thousands of duplicates.
  const rows = notes.list({
    folderId: folderId ?? undefined,
    limit: 5000,
    offset: 0,
  });
  return rows.some((n) => n.title === title);
}

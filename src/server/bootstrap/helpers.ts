import { existsSync, unlinkSync } from 'node:fs';
import type { ToolContext } from '../tools/types.js';

/**
 * Fire-and-forget embedding re-index. ONNX inference for a 50 KB
 * markdown note takes hundreds of ms on CPU; awaiting it inline blocks
 * every other HTTP response, including the WebSocket broadcast the UI
 * uses for live sync. Kick it off on the next tick instead so the HTTP
 * response returns immediately.
 *
 * FTS is already updated by a synchronous SQL trigger on notes
 * insert/update/delete, so keyword search stays consistent. The window
 * where a note is findable via keyword but not yet via vector
 * similarity is the acceptable trade-off.
 *
 * Proper fix (post-v1.0): worker_threads with a queue keyed by noteId,
 * so repeated edits dedupe down to a single latest reindex.
 *
 * Shared across notes/folders/revisions routes — before R1 this was
 * closed over inside `buildHttpApp`, now it's an exported helper so
 * every route module can fire the same scheduler without duplicating
 * the setImmediate pattern.
 */
export function scheduleReindex(
  ctx: Pick<ToolContext, 'indexer'>,
  note: { id: string },
): void {
  setImmediate(() => {
    ctx.indexer
      .reindex(note as never)
      .catch((err: unknown) =>
        console.error(`[reindex ${note.id}]`, (err as Error).message),
      );
  });
}

/**
 * Collect attachment file paths for the given notes BEFORE a hard-purge,
 * unlink them AFTER the purge succeeds. Must run in this order because
 * `attachments.note_id` has `ON DELETE CASCADE` — once the note row is
 * gone, the attachment rows are gone too, and we lose the `file_path`
 * needed to clean the disk.
 *
 * Returns the count of files unlinked for logging. Unlink failures
 * (missing file, permission denied) are logged but don't throw — DB is
 * source of truth, a stale file on disk is a minor leak, not a
 * correctness issue.
 *
 * Usage:
 *   const ids = [noteId];
 *   const paths = ctx.attachments.pathsForNotes(ids);
 *   ctx.notes.purge(noteId, actor);
 *   unlinkAttachmentFiles(paths);
 */
export function unlinkAttachmentFiles(paths: string[]): number {
  let unlinked = 0;
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        unlinkSync(p);
        unlinked++;
      }
    } catch (err) {
      console.warn(
        `[attachments] unlink failed for ${p}: ${(err as Error).message}`,
      );
    }
  }
  return unlinked;
}

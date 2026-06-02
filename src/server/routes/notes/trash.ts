import type { Hono } from 'hono';
import type { ToolContext } from '../../tools/types.js';
import { unlinkAttachmentFiles } from '../../bootstrap/helpers.js';

/**
 * Trash routes — `GET /api/notes/trash` (read + GC) and
 * `DELETE /api/notes/trash` (empty trash). Both MUST register before
 * `/api/notes/:id` so the literal "trash" segment matches first
 * instead of being captured as the id parameter. Hono trie ordering
 * pinned by registration order in `registerNoteRoutes`.
 *
 * The 7-day retention purge runs at read time — opening the Trash
 * view drives garbage collection in the MVP.
 *
 * Extracted from src/server/routes/notes.ts during the 2026-05-16
 * split (Morion ticket 01KRR8J8ED8E8QE37W3QRBP8G7).
 */
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function registerNotesTrashRoutes(app: Hono, ctx: ToolContext): void {
  app.get('/api/notes/trash', (c) => {
    const now = Date.now();
    const cutoff = now - TRASH_RETENTION_MS;
    // Collect attachment file paths BEFORE the purge — ON DELETE CASCADE
    // on attachments.note_id wipes the rows when the notes are hard-
    // deleted, so we'd lose the file_paths needed to clean the disk.
    // Direction P — Phase 1c orphan cleanup.
    const willPurge = ctx.notes
      .listTrashed(cutoff)
      .filter((n) => n.deletedAt !== null && n.deletedAt < cutoff)
      .map((n) => n.id);
    const attachmentPaths = ctx.attachments.pathsForNotes(willPurge);
    const purged = ctx.notes.purgeOlderThan(cutoff);
    for (const id of purged) ctx.indexer.remove(id);
    unlinkAttachmentFiles(attachmentPaths);
    const notes = ctx.notes.listTrashed(cutoff);
    return c.json(notes);
  });

  // Empty the trash. Hard-deletes every currently soft-deleted note,
  // regardless of how recently it was trashed.
  app.delete('/api/notes/trash', (c) => {
    // Snapshot trashed note ids first so we can collect attachment paths
    // before the cascade fires. listTrashed returns everything currently
    // in the trash; passing Number.NEGATIVE_INFINITY wouldn't work because
    // of the `deleted_at >= cutoff` filter, so use 0 as "include all
    // rows with non-null deleted_at".
    const trashedIds = ctx.notes.listTrashed(0).map((n) => n.id);
    const attachmentPaths = ctx.attachments.pathsForNotes(trashedIds);
    const ids = ctx.notes.purgeAllTrashed();
    for (const id of ids) ctx.indexer.remove(id);
    unlinkAttachmentFiles(attachmentPaths);
    return c.json({ purged: ids.length });
  });
}

import type Database from 'better-sqlite3';
import type { AuditLogger } from '../../audit/log.js';
import type { Note } from '../types.js';
import { type NoteRow } from './mappers.js';
import { SELECT_COLUMNS } from './queries.js';
import { rowsToNotes } from './tags.js';
import { getById } from './read.js';

/**
 * Soft-deleted notes that are still inside the trash window. Caller passes
 * the cutoff timestamp (`Date.now() - retentionMs`) — anything with
 * `deleted_at >= cutoff` is in the trash, anything older has already aged
 * out and is fair game for `purgeOlderThan`. Sorted by `deleted_at` desc so
 * the most recently trashed appears first, matching every Trash UI in the
 * world.
 */
export function listTrashed(db: Database.Database, cutoff: number): Note[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM notes
       WHERE deleted_at IS NOT NULL AND deleted_at >= ?
       ORDER BY deleted_at DESC`,
    )
    .all(cutoff) as NoteRow[];
  return rowsToNotes(db, rows);
}

/**
 * Bring a soft-deleted note back to life. Clears `deleted_at` without
 * touching `updated_at` — restoring is metadata, not a content edit
 * (Apple Notes parity with `update()`'s folder/pin/tag rule). Returns
 * the freshly-restored note, or `null` if the id doesn't exist or
 * isn't actually in the trash.
 *
 * The FTS sync triggers re-add the row automatically when `deleted_at`
 * flips back to NULL (see migration 0001 `notes_au` trigger). The vector
 * index is the caller's responsibility — repository never touches it.
 */
export function restore(
  db: Database.Database,
  audit: AuditLogger,
  id: string,
  actor: string,
): Note | null {
  const result = db
    .prepare('UPDATE notes SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL')
    .run(id);
  if (result.changes === 0) return null;
  audit.record({ noteId: id, action: 'update', actor });
  return getById(db, audit, id);
}

/**
 * Hard-delete every soft-deleted note whose `deleted_at` is older than the
 * cutoff. Returns the ids that were purged so the caller can clean up the
 * vector index (FTS + note_tags + attachments cascade via SQL triggers and
 * foreign keys). Audit rows are preserved — the `audit_log.note_id` keeps
 * the historical reference even after the row is gone.
 */
export function purgeOlderThan(db: Database.Database, cutoff: number): string[] {
  const rows = db
    .prepare<[number], { id: string }>(
      'SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?',
    )
    .all(cutoff);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const stmt = db.prepare('DELETE FROM notes WHERE id = ?');
  const tx = db.transaction((toDelete: string[]) => {
    for (const id of toDelete) stmt.run(id);
  });
  tx(ids);
  return ids;
}

/**
 * Hard-delete a single soft-deleted note. Refuses to touch live notes —
 * the only way a row can be permanently removed is by going through the
 * trash first. Returns true on success, false if the id doesn't exist or
 * the note is still live. Same FTS / note_tags cascade as `purgeOlderThan`.
 * Audit row is left intact for historical traceability.
 */
export function purge(
  db: Database.Database,
  audit: AuditLogger,
  id: string,
  actor: string,
): boolean {
  const result = db
    .prepare('DELETE FROM notes WHERE id = ? AND deleted_at IS NOT NULL')
    .run(id);
  if (result.changes === 0) return false;
  audit.record({ noteId: id, action: 'delete', actor });
  return true;
}

/**
 * Hard-delete a live note in one step (skip the soft-delete → trash
 * stage). Used by the "delete folder + notes inside" route for
 * `mo:*` system notes — they're machine-maintained indices and
 * shouldn't take up Trash space the user has to triage. Regular
 * user notes always go through `delete()` (soft) so they can be
 * restored. One audit row is written for traceability.
 */
export function hardDelete(
  db: Database.Database,
  audit: AuditLogger,
  id: string,
  actor: string,
): boolean {
  const result = db
    .prepare('DELETE FROM notes WHERE id = ?')
    .run(id);
  if (result.changes === 0) return false;
  audit.record({ noteId: id, action: 'delete', actor });
  return true;
}

/**
 * Empty the trash: hard-delete every soft-deleted note regardless of how
 * old it is. Returns the ids that were removed so the caller can drop them
 * from the vector index. Used by the "Empty Trash" button in the UI.
 *
 * Race safety: the SELECT (id list snapshot) and the DELETEs run inside
 * one better-sqlite3 transaction. A concurrent `restore(id)` arriving via
 * MCP or a second HTTP request between the SELECT and the DELETE used to
 * be able to slip a note out of the trash just before it got purged, and
 * the DELETE (keyed only on id) would hard-delete the restored note. The
 * DELETE now carries `AND deleted_at IS NOT NULL` as a belt-and-braces
 * guard: even if transaction isolation somehow lets the restore interleave,
 * the DELETE becomes a no-op for restored rows.
 */
export function purgeAllTrashed(db: Database.Database): string[] {
  const tx = db.transaction(() => {
    const rows = db
      .prepare<[], { id: string }>('SELECT id FROM notes WHERE deleted_at IS NOT NULL')
      .all();
    if (rows.length === 0) return [] as string[];
    const stmt = db.prepare(
      'DELETE FROM notes WHERE id = ? AND deleted_at IS NOT NULL',
    );
    const deleted: string[] = [];
    for (const r of rows) {
      const info = stmt.run(r.id);
      if (info.changes > 0) deleted.push(r.id);
    }
    return deleted;
  });
  return tx();
}

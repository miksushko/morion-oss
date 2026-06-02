import type Database from 'better-sqlite3';
import type { AuditLogger } from '../../audit/log.js';

/**
 * Soft-delete is metadata, not a content edit — leave `updated_at` alone
 * so that restoring the note from the trash later puts it back at its
 * original date-sorted position instead of slamming it to the top.
 */
export function deleteNote(
  db: Database.Database,
  audit: AuditLogger,
  id: string,
  actor: string,
): boolean {
  const result = db
    .prepare('UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(Date.now(), id);
  if (result.changes === 0) return false;
  audit.record({ noteId: id, action: 'delete', actor });
  return true;
}

/**
 * Toggle archive state on a note. Archive = hidden from default lists
 * + MCP; no 7-day purge. Metadata only, `updated_at` stays put
 * (content-timestamp rule). Audit row tags the action for the activity
 * feed.
 */
export function archive(
  db: Database.Database,
  audit: AuditLogger,
  id: string,
  actor: string,
): boolean {
  const result = db
    .prepare(
      'UPDATE notes SET archived_at = ? WHERE id = ? AND archived_at IS NULL AND deleted_at IS NULL',
    )
    .run(Date.now(), id);
  if (result.changes === 0) return false;
  audit.record({ noteId: id, action: 'archive', actor });
  return true;
}

export function unarchive(
  db: Database.Database,
  audit: AuditLogger,
  id: string,
  actor: string,
): boolean {
  const result = db
    .prepare(
      'UPDATE notes SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL AND deleted_at IS NULL',
    )
    .run(id);
  if (result.changes === 0) return false;
  audit.record({ noteId: id, action: 'unarchive', actor });
  return true;
}

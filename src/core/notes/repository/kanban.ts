import type Database from 'better-sqlite3';
import type { AuditLogger } from '../../audit/log.js';
import type { Note, NoteStatus, TasksListFilters } from '../types.js';
import { MANUAL_ORDER_STATUSES } from '../types.js';
import { type NoteRow } from './mappers.js';
import { SELECT_COLUMNS } from './queries.js';
import { rowsToNotes } from './tags.js';
import { computeInsertPosition } from './positions.js';
import { getById } from './read.js';

/**
 * Direction N — kanban column query. Unlike `list()`, always
 * folder-scoped (kanban is a per-folder concept), column-aware, and
 * sorts by column:
 *   - `note` column: updated_at DESC (chronology, no manual reorder).
 *   - everything else: position ASC, nulls last, id DESC as tie-break.
 *
 * Filter `since/until` reuse `updated_at` — we deliberately did NOT add
 * a `due_date` field (anti-feature). `status` filter narrows to a single
 * column; leave it unset to get the whole board.
 */
export function listKanban(
  db: Database.Database,
  filters: TasksListFilters & { includeArchived?: boolean },
): Note[] {
  const conditions: string[] = [
    'deleted_at IS NULL',
    'folder_id = ?',
  ];
  const params: (string | number)[] = [filters.folderId];
  if (!filters.includeArchived) {
    conditions.push('archived_at IS NULL');
  }
  // Exclude `mo:*` system notes (catalog / cluster / risks / patrol-log)
  // by default — this was the one `list()`-style read path missing the
  // mo-system filter, so `tasks_list` (and the UI board) leaked machine
  // indices as if they were kanban cards, drowning real tasks on a
  // Mo-indexed folder. Part of the 7-layer defence — see read.ts.
  if (!filters.includeMoSystem) {
    conditions.push("(source IS NULL OR source NOT LIKE 'mo:%')");
  }

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.since !== undefined) {
    conditions.push('updated_at >= ?');
    params.push(filters.since);
  }
  if (filters.until !== undefined) {
    conditions.push('updated_at <= ?');
    params.push(filters.until);
  }

  // `note` column is chronological; manual-order columns use position.
  // When the query spans multiple columns, sort by column first so the
  // caller can group easily — CASE orders them in their kanban sequence.
  const orderBy = `
    CASE status
      WHEN 'note'    THEN 0
      WHEN 'backlog' THEN 1
      WHEN 'todo'    THEN 2
      WHEN 'doing'   THEN 3
      WHEN 'review'  THEN 4
      WHEN 'done'    THEN 5
      ELSE 6
    END ASC,
    CASE WHEN status = 'note' THEN updated_at END DESC,
    position ASC NULLS LAST,
    id DESC
  `;

  const sql = `SELECT ${SELECT_COLUMNS} FROM notes
               WHERE ${conditions.join(' AND ')}
               ORDER BY ${orderBy}
               LIMIT ?`;
  // Repository can be called directly from tests / HTTP that bypass zod —
  // fall back to a sane default rather than trust the type annotation.
  params.push(filters.limit ?? 200);
  const rows = db.prepare(sql).all(...params) as NoteRow[];
  return rowsToNotes(db, rows);
}

/**
 * Direction N — move a note between (or within) kanban columns.
 * Semantically equivalent to drag-and-drop. Does NOT bump `updated_at`
 * — status change is metadata, not content (lessons.md 2026-04-10).
 *
 * `afterNoteId`:
 *   - null  → insert at top of the target column
 *   - undefined → same as null (convenience)
 *   - string → midpoint between `afterNoteId` and the card below it
 *
 * The `note` column ignores position entirely (chronological sort).
 * Moving INTO `note` clears position to NULL. Moving OUT of `note`
 * computes a position (top of column if no `afterNoteId`).
 *
 * Writes exactly one audit row:
 *   { action: 'status_change', status_from, status_to }
 * when the status actually changes. Pure intra-column reorder writes
 * nothing to audit — it's noise.
 *
 * Returns the updated note, or null if the id doesn't exist / is trashed.
 */
export function moveToKanban(
  db: Database.Database,
  audit: AuditLogger,
  id: string,
  status: NoteStatus,
  afterNoteId: string | null | undefined,
  actor: string,
): Note | null {
  const existing = getById(db, audit, id);
  if (!existing) return null;

  const folderId = existing.folderId;
  const statusChanged = existing.status !== status;

  let newPosition: number | null = null;
  if (MANUAL_ORDER_STATUSES.includes(status)) {
    newPosition = computeInsertPosition(db, folderId, status, afterNoteId, id);
  } else {
    // 'note' column — chronological, position is irrelevant.
    newPosition = null;
  }

  const tx = db.transaction(() => {
    db
      .prepare('UPDATE notes SET status = ?, position = ? WHERE id = ?')
      .run(status, newPosition, id);
    if (statusChanged) {
      audit.recordStatusChange({
        noteId: id,
        actor,
        statusFrom: existing.status,
        statusTo: status,
      });
    }
  });
  tx();

  return getById(db, audit, id);
}

/**
 * Direction N — atomic "take this task" primitive, the race-condition
 * guard against two agents pulling the same todo simultaneously.
 *
 * Implementation is a single conditional UPDATE: SQLite serialises
 * statement execution per connection, and better-sqlite3 is synchronous
 * single-threaded — so exactly one concurrent call hits `changes() > 0`,
 * the rest get `{claimed: false}` and can pick another task. No
 * transaction wrapping needed for the atomicity itself; we still wrap
 * to bundle the audit write with the state change.
 *
 * Only `todo → doing` is a legitimate claim. Anything else returns
 * `{claimed: false}` without mutation (including notes already in
 * `doing`). Agent should reconcile with `tasks_list` if claim fails.
 */
export function claimTask(
  db: Database.Database,
  audit: AuditLogger,
  id: string,
  actor: string,
): { claimed: boolean; note: Note | null } {
  const existing = getById(db, audit, id);
  if (!existing) return { claimed: false, note: null };

  const tx = db.transaction(() => {
    const info = db
      .prepare(`UPDATE notes SET status = 'doing' WHERE id = ? AND status = 'todo' AND deleted_at IS NULL`)
      .run(id);
    if (info.changes === 0) return { claimed: false, note: getById(db, audit, id) };
    audit.recordStatusChange({
      noteId: id,
      actor,
      statusFrom: 'todo',
      statusTo: 'doing',
    });
    return { claimed: true, note: getById(db, audit, id) };
  });
  return tx();
}

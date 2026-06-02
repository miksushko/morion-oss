import type Database from 'better-sqlite3';
import type { NoteStatus } from '../types.js';
import { POSITION_GAP } from './queries.js';

/**
 * Compute the REAL position for inserting `movingId` after `afterNoteId`
 * in the (folderId, status) column.
 *
 * Edge cases:
 *   - empty column: return POSITION_GAP (just some positive number)
 *   - afterNoteId is null/undefined: insert at top — position = (minPos - GAP)
 *     OR (first.position / 2) if the top is already positive (keeps values
 *     positive-ish on average; negative positions are allowed but noisy).
 *   - afterNoteId has no card below it: append — position = (maxPos + GAP)
 *   - midpoint between A and B: (A.position + B.position) / 2
 *
 * `movingId` is excluded from the column snapshot so self-reposition
 * doesn't pick itself as a neighbour.
 */
export function computeInsertPosition(
  db: Database.Database,
  folderId: string | null,
  status: NoteStatus,
  afterNoteId: string | null | undefined,
  movingId: string,
): number {
  const folderCondition = folderId === null ? 'folder_id IS NULL' : 'folder_id = ?';
  const folderParam = folderId === null ? [] : [folderId];

  const rows = db
    .prepare<unknown[], { id: string; position: number | null }>(
      `SELECT id, position FROM notes
       WHERE ${folderCondition} AND status = ? AND deleted_at IS NULL AND id != ?
       ORDER BY position ASC NULLS LAST, id DESC`,
    )
    .all(...folderParam, status, movingId);

  if (rows.length === 0) return POSITION_GAP;

  if (afterNoteId === undefined || afterNoteId === null) {
    // Top of column
    const first = rows[0];
    if (first && first.position !== null) return first.position - POSITION_GAP;
    return POSITION_GAP;
  }

  const afterIndex = rows.findIndex((r) => r.id === afterNoteId);
  if (afterIndex === -1) {
    // Caller named a non-existent neighbour — fall back to append
    const last = rows[rows.length - 1];
    const lastPos = last?.position ?? 0;
    return lastPos + POSITION_GAP;
  }

  const after = rows[afterIndex]!;
  const next = rows[afterIndex + 1];
  const afterPos = after.position ?? afterIndex * POSITION_GAP;

  if (!next || next.position === null) {
    // Append after the last known position
    return afterPos + POSITION_GAP;
  }
  return (afterPos + next.position) / 2;
}

/**
 * Next top-of-column position for a newly-created card. Used by `create()`
 * when the note lands in a manual-order column. Always places the new
 * card at the visual top of the column (lowest position value).
 */
export function nextPositionForColumn(
  db: Database.Database,
  folderId: string | null,
  status: NoteStatus,
): number {
  const folderCondition = folderId === null ? 'folder_id IS NULL' : 'folder_id = ?';
  const folderParam = folderId === null ? [] : [folderId];
  const row = db
    .prepare<unknown[], { min: number | null }>(
      `SELECT MIN(position) AS min FROM notes
       WHERE ${folderCondition} AND status = ? AND deleted_at IS NULL`,
    )
    .get(...folderParam, status);
  const min = row?.min ?? null;
  if (min === null) return POSITION_GAP;
  return min - POSITION_GAP;
}

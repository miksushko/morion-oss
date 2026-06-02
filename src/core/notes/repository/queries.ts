/**
 * SQL string constants used by `NotesRepository`. Extracted so the
 * column list has a single source of truth (mirrors `NoteRow` in
 * `mappers.ts`) and so the position-gap constant doesn't sit lost
 * inside the class file.
 *
 * Pure module — no DB access, no side effects.
 */

/** Column list for `SELECT … FROM notes`. Mirrors `NoteRow`. */
export const SELECT_COLUMNS = `
  id, folder_id, title, body, pinned, source, created_at, updated_at, deleted_at,
  archived_at, status, position, workflow_id,
  mcp_visible, mcp_update, mcp_delete
`;

/** Same column list but every column prefixed with `n.` for joined
 *  queries that alias the notes table as `n`. */
export const SELECT_COLUMNS_N = SELECT_COLUMNS.split(',')
  .map((c) => `n.${c.trim()}`)
  .join(', ');

/**
 * Default position gap between manually-ordered cards in a kanban column.
 * Mid-point inserts divide the gap by 2 each time; after ~30 consecutive
 * inserts between the same two neighbours the float precision runs out
 * and we'd need a rebalance pass. For solo-founder workflows 30 inserts
 * between the same pair is unrealistic — rebalance deferred to post-MVP.
 */
export const POSITION_GAP = 1.0;

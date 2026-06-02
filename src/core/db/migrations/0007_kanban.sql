-- Agent work queue (kanban view) — Direction N, v1.0.0.
--
-- Second product wedge: Morion shifts from "local notebook + MCP memory" to
-- "local workspace for you and your AI agents". Notes stay memory, kanban
-- becomes work queue. Cross-session, cross-agent, local, MCP-native.
--
-- Three additions:
--
-- 1. folders.view_mode — per-folder property that decides whether the folder
--    renders as a list (default, unchanged behaviour) or as a 6-column
--    kanban board. NOT a UI toggle within a folder; a folder is one or the
--    other at any time. list <-> kanban flips preserve all status/position
--    values (data-preserve principle, same as Pro permissions across
--    downgrade — lessons.md 2026-04-14).
--
-- 2. notes.status + notes.position — status is one of 6 fixed values, with
--    'note' as the safe default ("reference / spec / idea on the shelf",
--    semantically distinct from 'backlog' = executable work queued up).
--    position is REAL so drag-between-cards inserts a mid-point without
--    renumbering the whole column. Nullable — only used in backlog/todo/
--    doing/review/done. 'note' column sorts by updated_at desc, not position.
--
-- 3. audit_log.status_from / status_to — typed columns, not JSON, so the
--    MCP tool tasks_history(noteId) can filter and sort with plain SQL.
--    Populated by tasks_move when it writes an action='status_change' row.
--
-- Guard rails:
-- - CHECK constraints on both new TEXT columns so a typo can't land
--   'in-progress' in status and silently fail column filtering.
-- - Index (folder_id, status, position) covers the kanban list query.
-- - Trailing WHERE deleted_at IS NULL in the index keeps soft-deleted notes
--   out of the kanban view without a secondary filter.

ALTER TABLE folders ADD COLUMN view_mode TEXT NOT NULL DEFAULT 'list'
  CHECK (view_mode IN ('list', 'kanban'));

ALTER TABLE notes ADD COLUMN status TEXT NOT NULL DEFAULT 'note'
  CHECK (status IN ('note', 'backlog', 'todo', 'doing', 'review', 'done'));

ALTER TABLE notes ADD COLUMN position REAL;

ALTER TABLE audit_log ADD COLUMN status_from TEXT;
ALTER TABLE audit_log ADD COLUMN status_to   TEXT;

CREATE INDEX IF NOT EXISTS idx_notes_kanban
  ON notes(folder_id, status, position)
  WHERE deleted_at IS NULL;

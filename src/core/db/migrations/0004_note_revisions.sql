-- Migration 0004: per-note version history.
--
-- Each row is a frozen snapshot of a note's content (title, body, folder, tag
-- ids) taken before a mutation. The repository enforces a 3-recent + 1-baseline
-- retention policy at insert time so a single note never exceeds four rows.
--
-- ON DELETE CASCADE: hard-purging a note (Trash → Delete forever, or 7-day
-- retention sweep) drops its revisions automatically. Soft-delete leaves the
-- revisions intact so a Restore-from-Trash still has its history.

CREATE TABLE note_revisions (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  tags_json  TEXT NOT NULL,
  folder_id  TEXT,
  actor      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_note_revisions_note ON note_revisions(note_id, created_at DESC);

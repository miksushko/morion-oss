-- Migration 0009: per-note discussion threads (Direction Q).
--
-- Free-form user/agent comments scoped to a note. Complements the existing
-- timelines without merging:
--   - audit_log  → system events (create / update / delete / status_change /
--                 comment_delete tombstone). No FK to notes; forensic record.
--   - note_revisions → body snapshots with 3+1 retention. UI-only.
--   - note_comments  → this table. Free-form prose, 1-level reply threading,
--                     no retention (user/agent content — unbounded by design).
--
-- 1-level reply enforcement lives in the repo (`NoteCommentsRepository`), not
-- in a SQL CHECK: cross-row CHECKs in SQLite require a trigger and the repo
-- already does the lookup for its monotonic-ulid mint so we get the check for
-- free on the insert path.
--
-- ON DELETE CASCADE chain:
--   notes.id → note_comments.note_id     → hard-purge a note drops its comments
--   note_comments.id → note_comments.parent_id → deleting a top-level drops its replies
--
-- Soft-delete (notes.deleted_at non-null) does NOT propagate here — comments
-- stay readable while a note is in trash so Restore-from-Trash keeps history.
-- Only hard-purge (Empty Trash / 7-day sweep / DELETE /api/notes/:id/purge)
-- reaps comments, matching revisions' cascade policy.

CREATE TABLE note_comments (
  id          TEXT PRIMARY KEY,
  note_id     TEXT NOT NULL REFERENCES notes(id)          ON DELETE CASCADE,
  parent_id   TEXT          REFERENCES note_comments(id)  ON DELETE CASCADE,
  body        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);

-- Per-note chronological reads (list + activity UNION both order by created_at).
CREATE INDEX idx_note_comments_note    ON note_comments(note_id, created_at);
-- Reply lookup — partial index skips the ~99% of top-level rows where parent_id IS NULL.
CREATE INDEX idx_note_comments_parent  ON note_comments(parent_id) WHERE parent_id IS NOT NULL;

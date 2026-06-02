-- Direction X v3 — Mo Project Brief as a first-class per-folder object.
--
-- Migration 0012 shipped Brief as a regular note (source='mo:brief').
-- That works for storage + reuse-of-editor but exposes the Brief to
-- drag-between-folders, delete, duplicate — all of which corrupt the
-- 1:1-with-folder contract. v3 moves Brief into its own table keyed by
-- folder_id so it CANNOT be moved, CANNOT be duplicated, and is
-- hard-deleted only when the parent folder is deleted (CASCADE).
--
-- Copies existing `source='mo:brief'` note bodies into the new table so
-- live briefs aren't lost on upgrade, then leaves the notes alone (they
-- become inert rows with `source='mo:brief'` that users can delete
-- manually). We don't soft-delete them automatically because the user
-- may have edited the brief; preserving the note is a safety net.
--
-- concierge_folder_settings.brief_note_id / brief_checkpoint_at /
-- brief_last_digest_at from migration 0012 become dead fields. Engine
-- no longer consults them — the new folder_briefs table is the source
-- of truth. SQLite can't DROP COLUMN without a table rebuild; leaving
-- them inert is cheaper than a rebuild and keeps the migration small.

CREATE TABLE IF NOT EXISTS folder_briefs (
  folder_id        TEXT PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
  body             TEXT NOT NULL DEFAULT '',
  checkpoint_at    INTEGER,
  last_digest_at   INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- One-shot copy of existing mo:brief notes into the new table. Uses
-- INSERT OR IGNORE so a re-run of the migration is a no-op (fresh
-- installs skip it entirely because there are no pre-existing brief
-- notes). We key by folder_id so a note that was already moved to a
-- different folder before this migration sticks with its current
-- folder_id — that matches user intent (wherever they put the note is
-- where the brief lives now).
INSERT OR IGNORE INTO folder_briefs (
  folder_id, body, checkpoint_at, last_digest_at, created_at, updated_at
)
SELECT
  n.folder_id,
  n.body,
  cfs.brief_checkpoint_at,
  cfs.brief_last_digest_at,
  n.created_at,
  n.updated_at
FROM notes n
LEFT JOIN concierge_folder_settings cfs ON cfs.folder_id = n.folder_id
WHERE n.source = 'mo:brief'
  AND n.deleted_at IS NULL
  AND n.folder_id IS NOT NULL;

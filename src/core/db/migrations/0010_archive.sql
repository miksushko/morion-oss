-- Archive support for notes + folders.
-- Distinct from `deleted_at`: archived items are hidden from default
-- lists + MCP but remain reachable via a "Show Archived" UI toggle.
-- Deleted items live in Trash with a 7-day purge; archive has no expiry.

ALTER TABLE folders ADD COLUMN archived_at INTEGER NULL;
ALTER TABLE notes   ADD COLUMN archived_at INTEGER NULL;

-- Partial indexes for the "filter out archived" query on every default
-- list. Archived rows are rare relative to active rows, so a partial
-- index on `archived_at IS NOT NULL` keeps the index small while still
-- accelerating the "show archived only" case.
CREATE INDEX IF NOT EXISTS idx_folders_archived ON folders(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_archived   ON notes(archived_at)   WHERE archived_at IS NOT NULL;

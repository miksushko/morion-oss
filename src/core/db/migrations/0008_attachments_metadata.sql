-- Direction P — inline image support, v1.0.x.
--
-- The `attachments` table has existed since migration 0001 (MVP scaffold)
-- but was never populated until Tiptap paste/drop landed. Add three columns
-- needed by the actual implementation:
--
-- 1. `created_at` — insert timestamp. Required for chronological ordering in
--    `notes_list_attachments` (Phase 4 MCP tool) and for future orphan-GC
--    policies ("files older than N that aren't referenced by any live note").
--
-- 2. `width` / `height` — pixel dimensions for image MIME types. Read at
--    upload time from the file header (file-type + probe) and cached on the
--    row so the MCP `notes_list_attachments` tool can return them without
--    re-reading the file every call. Nullable because (a) existing rows
--    have none, (b) non-image types in the future wouldn't have dimensions
--    (we reject non-images in v1 but the column stays nullable for forward
--    compat).
--
-- Schema.sql in the repo was left with the MVP attachments shape for
-- readability — see docs note in docs/PLAN.md Direction P. This migration
-- is the authoritative version at runtime (runMigrations replays all .sql
-- files in order).
--
-- Idempotent via ADD COLUMN (SQLite doesn't support IF NOT EXISTS on
-- ALTER TABLE ADD COLUMN — if the migration has already run the version
-- row in schema_migrations prevents re-execution).

ALTER TABLE attachments ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN width      INTEGER;
ALTER TABLE attachments ADD COLUMN height     INTEGER;

CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at);

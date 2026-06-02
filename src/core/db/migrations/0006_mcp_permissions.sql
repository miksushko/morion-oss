-- Per-folder and per-note MCP access control (Morion Pro, v0.98.0).
--
-- Folders carry four booleans gating what AI assistants connected via MCP
-- can do with the folder's notes: see them at all, create new ones, edit
-- existing ones, delete them. Defaults are all-true so existing
-- installations keep behaving as they do today (everything visible).
--
-- Notes carry the same flags but NULLABLE — null means "inherit from the
-- containing folder". Override only what differs. Lookup in
-- src/core/permissions/check.ts goes note → folder → defaults.
--
-- Note: there is no `mcp_create` on `notes` (you don't create notes
-- inside notes). The folder's `mcp_create` is the only gate for new note
-- creation.
--
-- Enforcement is gated by license tier (`isPro` in src/core/license/verify.ts):
-- Free tier ignores these columns entirely and acts as if every flag is 1.
-- Stored values stay in the database across downgrade so a re-upgrade
-- restores the user's previous choices without requiring re-entry.

ALTER TABLE folders ADD COLUMN mcp_visible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE folders ADD COLUMN mcp_create  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE folders ADD COLUMN mcp_update  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE folders ADD COLUMN mcp_delete  INTEGER NOT NULL DEFAULT 1;

ALTER TABLE notes ADD COLUMN mcp_visible INTEGER;
ALTER TABLE notes ADD COLUMN mcp_update  INTEGER;
ALTER TABLE notes ADD COLUMN mcp_delete  INTEGER;

-- Auto-code Phase 1 — per-folder linked git repo + auto_code_enabled toggle.
--
-- Sub-ticket: 01KQEEA0F4EQPQ5VHS69PV4JKJ
-- Umbrella:   01KQANTZDKW6QH461AK2JN3DCQ
--
-- Storage for the auto-code loop:
--   - `linked_repo_path`  — absolute path to the git repo Mo will run
--                            Claude/Codex against. NULL = not yet linked,
--                            blocks `auto_code_enabled` from going true.
--   - `auto_code_enabled` — per-folder toggle for the kanban → Claude →
--                            Codex → Mo loop. Pro-gated at the route layer.
--
-- Both fields live alongside Mo's `enabled` column on
-- `concierge_folder_settings` because the auto-code loop is orchestrated
-- by Mo (Step 5 of umbrella spec — Mo evaluates ticket, packages context,
-- spawns agents). Per-folder grouping matches the existing UI surface
-- (FolderSettingsDialog) where a 6th "Auto-Code" tab joins the existing
-- 5 tabs.
--
-- Defaults: NULL / 0 — pre-existing folders are unaffected. New schema
-- is read-only until the user picks a repo and flips the toggle in UI.

ALTER TABLE concierge_folder_settings ADD COLUMN linked_repo_path TEXT;
ALTER TABLE concierge_folder_settings ADD COLUMN auto_code_enabled INTEGER NOT NULL DEFAULT 0;

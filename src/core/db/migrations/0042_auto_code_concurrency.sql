-- Auto-code per-folder concurrency cap.
--
-- Makes the previously-hardcoded MAX_INFLIGHT_PER_FOLDER (workflow
-- orchestrator admission gate) configurable per folder. The admission
-- check reads `settings.autoCodeConcurrency` and falls back to the
-- workspace default (MAX_INFLIGHT_PER_FOLDER = 5) when NULL.
--
-- NULL = use the workspace default — pre-existing folders are
-- unaffected. A folder only deviates once the user sets an explicit
-- number in the FolderSettingsDialog "Auto-code" tab.

ALTER TABLE concierge_folder_settings ADD COLUMN auto_code_concurrency INTEGER;

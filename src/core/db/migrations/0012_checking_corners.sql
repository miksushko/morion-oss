-- Direction X — "Checking Corners" / Mo Project Brief
--
-- Extends concierge_folder_settings with four fields so Mo can maintain
-- a per-folder digest note (stored in the `notes` table, not a new one
-- — see lesson 2026-04-24 "Store LLM-generated durable artifacts as
-- regular notes"). The new columns link the settings row to the brief
-- note and track the delta checkpoint / last digest timestamps.
--
-- checking_corners_enabled — per-folder opt-in. Master kill-switch is a
--   settings-table JSON key (concierge.checking_corners_master), so no
--   migration is needed for the global toggle.
-- brief_note_id — FK-by-convention to notes.id. No DB-level FK because
--   a soft-deleted brief note should leave the setting row intact and
--   trigger recreation on the next digest; the engine handles null +
--   deleted_at IS NOT NULL identically.
-- brief_checkpoint_at — watermark for delta reads. null = "first run,
--   read everything". Advanced on each successful digest.
-- brief_last_digest_at — most recent digest run time. Used by the
--   engine to decide whether the brief is fresh enough to prepend to
--   the tick system prompt (< 24h) and by the UI to show a "last
--   digest: 47m ago" chip on the settings dialog.

ALTER TABLE concierge_folder_settings
  ADD COLUMN checking_corners_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE concierge_folder_settings
  ADD COLUMN brief_note_id TEXT;

ALTER TABLE concierge_folder_settings
  ADD COLUMN brief_checkpoint_at INTEGER;

ALTER TABLE concierge_folder_settings
  ADD COLUMN brief_last_digest_at INTEGER;

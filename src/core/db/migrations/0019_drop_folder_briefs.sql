-- Mo Indexing Redesign — Phase 6.1 cleanup: drop the legacy
-- `folder_briefs` table.
--
-- Folder memory is now maintained in per-folder `mo:catalog` notes
-- (Tier 2.5 output, see migration 0017_mo_metadata.sql + the
-- catalog/cluster/patrol-log helpers in src/core/concierge/). The
-- Phase 4 cutover (commit `bacaf63`) deleted `runBriefDigest` and
-- retargeted `buildWorkContextPacket` to read the catalog note;
-- this migration retires the storage now that no production code
-- reads or writes it.
--
-- The `concierge_folder_settings.brief_note_id` column added by
-- migration 0012 stays in the schema as orphaned NULL data — every
-- code path stopped reading it in Phase 6.1, but dropping the
-- column requires an ALTER TABLE rebuild that adds no behavioural
-- value. A future cleanup migration can drop it once we're
-- confident no rolled-back binary tries to read it.

DROP TABLE IF EXISTS folder_briefs;

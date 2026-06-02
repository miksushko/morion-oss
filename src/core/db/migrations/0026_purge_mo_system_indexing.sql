-- Mo Indexing — purge system-note pollution from indexing tables.
--
-- Ticket: 01KQKESWXPYV73V9FE614Q51HQ
--
-- `mo:*` system notes (mo:catalog / mo:cluster:* / mo:patrol-log /
-- mo:risks) are Mo's own index storage — they MUST NOT participate in
-- topic indexing themselves. Audit on Morion Features (2026-05-02)
-- found 17 such notes carrying `note_mo_clusters` rows (likely from
-- the audit-log enqueue path that filtered on `actor != 'morion-
-- concierge'` but not on `source NOT LIKE 'mo:%'`, so a user-actor
-- write touching a mo:* note would slip through).
--
-- This migration is a one-shot purge:
--   - DELETE every `note_mo_clusters` row whose note is a mo:* note.
--   - DELETE every `note_mo_metadata` row whose note is a mo:* note.
--   - DELETE every `mo_metadata_queue` row whose note is a mo:* note.
--
-- Code-side fixes in the same commit prevent re-pollution. After this
-- migration runs once, downstream views (Topics route, Tier 2.5
-- catalog, gatherClusterPanorama, mergeClusters source-set) all see
-- the clean state.

DELETE FROM note_mo_clusters
 WHERE note_id IN (
   SELECT id FROM notes WHERE source LIKE 'mo:%'
 );

DELETE FROM note_mo_metadata
 WHERE note_id IN (
   SELECT id FROM notes WHERE source LIKE 'mo:%'
 );

DELETE FROM mo_metadata_queue
 WHERE note_id IN (
   SELECT id FROM notes WHERE source LIKE 'mo:%'
 );

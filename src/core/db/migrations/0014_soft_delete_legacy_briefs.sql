-- Direction X v3 follow-up to migration 0013.
--
-- 0013 copies pre-v3 brief body out of the notes table into the new
-- `folder_briefs` table but leaves the source='mo:brief' notes in
-- place as a safety net (in case the user had edited them).
--
-- Side effect: those notes still show up in the NotesList alongside
-- regular notes, polluting the UI after upgrade. Now that the copy
-- has had a chance to be verified in 0013 (same commit), move the
-- legacy rows to the trash — soft-delete, NOT hard-delete, so users
-- can recover via Trash if their customisations weren't carried over.
-- The 7-day auto-purge (Direction E trash retention) eventually
-- reclaims the space.

UPDATE notes
SET deleted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE source = 'mo:brief'
  AND deleted_at IS NULL;

-- Migration 0003: make the FTS sync triggers tolerant of soft-deleted rows.
--
-- The original notes_au always emitted a 'delete' to notes_fts on every UPDATE
-- and the original notes_ad always emitted a 'delete' on hard DELETE. Both
-- worked under the old assumption that every row in `notes` is also in
-- `notes_fts`. With trash + restore + GC purge that assumption is gone:
--
--   * Restore (UPDATE deleted_at = NULL) hits notes_au with old.deleted_at
--     set — but the row is no longer in FTS, so the unconditional 'delete'
--     raises "database disk image is malformed" against the external-content
--     FTS5 table.
--   * purgeOlderThan (hard DELETE of trashed rows) hits notes_ad with the
--     same broken assumption.
--
-- The fix is symmetric across both triggers: only emit a 'delete' when the
-- OLD row was visible to FTS (deleted_at IS NULL), and only insert in
-- notes_au when the NEW row should be visible. Soft-delete, restore, content
-- edits, and hard purge all behave correctly and trash round-trips losslessly.

DROP TRIGGER IF EXISTS notes_au;
DROP TRIGGER IF EXISTS notes_ad;

CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body)
    SELECT 'delete', old.rowid, old.title, old.body
    WHERE old.deleted_at IS NULL;
  INSERT INTO notes_fts(rowid, title, body)
    SELECT new.rowid, new.title, new.body
    WHERE new.deleted_at IS NULL;
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body)
    SELECT 'delete', old.rowid, old.title, old.body
    WHERE old.deleted_at IS NULL;
END;

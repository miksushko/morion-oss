-- Mo Indexing — topic-cleanup decision memory.
--
-- Ticket: 01KQKDWH9CB7S4N0CKQ1DM8S9Q
--
-- One row per (folder, source_cluster, target_cluster) decision the
-- topic-hygiene job has either applied automatically or recorded after
-- the user resolved an Ask Mo edge-case chat. Without this memory the
-- next hygiene pass would re-propose every pair the user already said
-- "kept_separate" on, and the auto-apply path would flicker between
-- merging+unmerging clusters that drifted in and out by 0.0X confidence.
--
-- Decisions are FINAL inside this table. The user can manually
-- "reconsider" via UI (delete the row) — but cleanup will not
-- re-propose the same pair until the user explicitly opts back in.
--
-- Columns:
--   - decision='merged'         — source_cluster was rolled into target.
--                                  Reverse direction never appears in
--                                  the same row (each merge is one-way).
--   - decision='kept_separate'  — user said "these are different topics"
--                                  in an Ask Mo escalation, OR Mo
--                                  judged confidence below the
--                                  auto-apply threshold and the user
--                                  rejected.
--   - decision='demote_tag'     — source_cluster was demoted to a note
--                                  tag (generic-category cleanup, e.g.
--                                  `user-interface` -> tag `ui`).
--                                  target_cluster is empty here.
--
--   - decided_by='auto'         — Mo applied automatically because
--                                  confidence cleared the threshold.
--                                  Surfaces in audit so the user can
--                                  audit-trail-spot rogue auto-merges.
--   - decided_by='user'         — user explicitly answered an Ask Mo
--                                  edge-case prompt.
--
-- target_cluster nullable for the demote_tag decision (no merge target).
-- Lookup index: per-folder + per-source for the "have we already
-- decided this pair?" gate, plus a simple per-folder enumeration for
-- the audit/UI surface.

CREATE TABLE IF NOT EXISTS mo_topic_decisions (
  folder_id        TEXT NOT NULL,
  source_cluster   TEXT NOT NULL,
  target_cluster   TEXT,
  decision         TEXT NOT NULL CHECK (decision IN ('merged','kept_separate','demote_tag')),
  decided_by       TEXT NOT NULL CHECK (decided_by IN ('auto','user')),
  decided_at       INTEGER NOT NULL,
  reason           TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (folder_id, source_cluster, target_cluster)
);

CREATE INDEX IF NOT EXISTS idx_mo_topic_decisions_folder
  ON mo_topic_decisions(folder_id, decided_at DESC);

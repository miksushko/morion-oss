-- Mo Indexing Redesign — Phase 1 foundation tables.
-- Umbrella ticket 01KQ5BJGE724SWVZ8AAQA31EAK.
--
-- Four tables that underpin the new four-index model + event-driven
-- patrol queue (replacing the single-blob folder_briefs.body LLM digest):
--
-- 1. note_mo_metadata    — per-note metadata cache (1:1 with notes)
-- 2. note_mo_clusters    — many-to-many cluster assignment JOIN
-- 3. mo_metadata_queue   — per-note dirty queue with coalescing INSERT
-- 4. mo_cluster_queue    — per-cluster regen queue with longer debounce
--
-- Hard invariants (enforced at the repository / worker layer, not by SQL):
-- - Writes to note_mo_metadata MUST NOT bump notes.updated_at and MUST NOT
--   fire note_changed events. Otherwise Tier 1 self-triggers a feedback loop
--   (precedent: live-sync refetch storm 01KQ2BVN19Z46HKJ7V8GSAYTZJ).
-- - Cluster assignment is many-to-many. A note legitimately fits multiple
--   themes; a singular `cluster` field would force miscategorization.
-- - mo_metadata_queue rows coalesce on (folder_id, note_id, tier). Bursts
--   of edits to the same note collapse to one work-item with the latest
--   body_hash; idempotency is rechecked against current notes.body before
--   the LLM call.

-- ---------------------------------------------------------------------------
-- 1. note_mo_metadata — per-note metadata cache.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS note_mo_metadata (
  note_id        TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  summary        TEXT NOT NULL DEFAULT '',
  keywords       TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  body_hash      TEXT,                         -- sha256 of notes.body at compute time
  computed_by    TEXT,                         -- tier0|tier1|mo-sync|local|local+verified|cloud|user
  computed_at    INTEGER,
  confidence     REAL,                         -- 0.0..1.0
  mo_hands_off   INTEGER NOT NULL DEFAULT 0,   -- 1 = exclude from Tier 1+ entirely
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_mo_metadata_body_hash
  ON note_mo_metadata(body_hash);

CREATE INDEX IF NOT EXISTS idx_note_mo_metadata_computed_at
  ON note_mo_metadata(computed_at);

-- ---------------------------------------------------------------------------
-- 2. note_mo_clusters — many-to-many cluster assignment.
-- ---------------------------------------------------------------------------
-- cluster_id is a free-form string (e.g. 'kanban-ui', 'mo-chat-loop') —
-- not a FK to a separate clusters table for now. The set of cluster ids
-- per folder is derived from the population of this table + the
-- per-folder Tasks Topics tab user input. If we later need normalized
-- cluster names with descriptions / per-cluster house rules, a clusters
-- table can be added without breaking this JOIN.
CREATE TABLE IF NOT EXISTS note_mo_clusters (
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  cluster_id   TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 1.0,      -- 0.0..1.0
  source       TEXT NOT NULL,                  -- tier0|tier1|user|imported|verified
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (note_id, cluster_id)
);

CREATE INDEX IF NOT EXISTS idx_note_mo_clusters_cluster
  ON note_mo_clusters(cluster_id);

CREATE INDEX IF NOT EXISTS idx_note_mo_clusters_source
  ON note_mo_clusters(source);

-- ---------------------------------------------------------------------------
-- 3. mo_metadata_queue — per-note dirty queue with coalescing INSERT.
-- ---------------------------------------------------------------------------
-- Bursts of edits to the same note collapse via ON CONFLICT DO UPDATE on
-- (folder_id, note_id, tier). The worker reads rows ordered by
-- dirty_since ASC, claims via picked_at != NULL (in-flight protection),
-- and rechecks notes.body hash before the actual LLM call to handle the
-- case where another writer raced in.
CREATE TABLE IF NOT EXISTS mo_metadata_queue (
  folder_id    TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  note_id      TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tier         TEXT NOT NULL,                  -- tier0|tier1|tier-1
  body_hash    TEXT NOT NULL,                  -- sha256 of body when enqueued
  dirty_since  INTEGER NOT NULL,
  picked_at    INTEGER,                        -- NULL = available; non-NULL = claimed
  attempts     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (folder_id, note_id, tier)
);

CREATE INDEX IF NOT EXISTS idx_mo_metadata_queue_pick
  ON mo_metadata_queue(picked_at, dirty_since);

CREATE INDEX IF NOT EXISTS idx_mo_metadata_queue_folder
  ON mo_metadata_queue(folder_id, dirty_since);

-- ---------------------------------------------------------------------------
-- 4. mo_cluster_queue — per-cluster regen queue with longer debounce.
-- ---------------------------------------------------------------------------
-- Tier 2 cluster aggregator regen runs after Tier 1 settles for that
-- cluster's dirty notes. A 5-min Tier 1 burst that touches 30 notes in
-- one cluster produces ONE row here, not 30. picked_at logic mirrors
-- mo_metadata_queue.
CREATE TABLE IF NOT EXISTS mo_cluster_queue (
  folder_id    TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  cluster_id   TEXT NOT NULL,
  dirty_since  INTEGER NOT NULL,
  picked_at    INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (folder_id, cluster_id)
);

CREATE INDEX IF NOT EXISTS idx_mo_cluster_queue_pick
  ON mo_cluster_queue(picked_at, dirty_since);

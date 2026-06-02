-- Phase 5 of context restructure (ticket 01KQFQ1RJV7EH0X3WF2H1A476J).
--
-- Two-layer cache for `mo_get_context` / `mo_ask` synthesis packets:
--   1. Exact-match: cache_key = hash(taskId, body_hash, folder_catalog_hash, mode, scope)
--                   → return packet, TTL 1 hour, zero LLM cost.
--   2. Semantic-match: when no exact key, embed the incoming question,
--                      cosine vs every cached `question_embedding` from the
--                      last 24h, return best if similarity ≥ 0.92 + flag.
--
-- Why a separate table (not the existing concierge_messages or settings KV):
--   - Distinct lifecycle (TTL-driven cleanup, idempotent inserts on re-hit).
--   - Both indexable on cache_key (PK) AND scannable on created_at (TTL).
--   - Question embedding column is a BLOB sized to the workspace embedder
--     (384 floats × 4 bytes = 1.5 KB / row). Acceptable per row; cleanup
--     keeps the table bounded at the daily working set (~hundreds of rows).
--
-- Storage: TEXT for the packet JSON (synthesis output is markdown +
-- structured refs; small enough to inline). BLOB for the embedding.
-- `hit_count` lets us telemetry-rank "what users actually re-ask" later
-- without separate analytics infra.
--
-- The vec0 metadata embedding store from Phase 2 (`mo_metadata_vec`)
-- is NOT reused here — that's per-note summary embeddings; this is
-- per-question (different lifecycle, different dim accounting if the
-- embedder swaps, different cleanup cadence). Two separate concerns.

CREATE TABLE IF NOT EXISTS mo_context_cache (
  -- hash(taskId, body_hash, folder_catalog_hash, mode, scope)
  cache_key TEXT PRIMARY KEY,
  -- The synthesised packet (JSON-encoded WorkContextPacket).
  packet_json TEXT NOT NULL,
  -- Embedding of the incoming question/task. NULL for exact-match-only
  -- entries (rare path — every Phase 7 caller computes one per call).
  question_embedding BLOB,
  -- Mode the packet was synthesised for ('full' / 'resume' / 'ask' / etc.).
  -- Same task with different mode → different cache row.
  mode TEXT NOT NULL,
  -- Scope ('folder' / 'workspace'). Same task with workspace scope sees
  -- more material than folder-scoped → can't share the row.
  scope TEXT NOT NULL,
  -- ms-epoch creation. Cleanup drops rows older than 24h on insert.
  created_at INTEGER NOT NULL,
  -- Bumped on every cache hit. Telemetry only — no behaviour gates on it.
  hit_count INTEGER NOT NULL DEFAULT 0
);

-- Cleanup scan: most-recent-first lookup for semantic match (24h window),
-- and the "drop > 24h" prune both want this index.
CREATE INDEX IF NOT EXISTS idx_mo_context_cache_created_at
  ON mo_context_cache(created_at);

-- Telemetry-friendly secondary index. Cheap to maintain, lets a future
-- "what did Mo answer most often?" view skip a full scan.
CREATE INDEX IF NOT EXISTS idx_mo_context_cache_hit_count
  ON mo_context_cache(hit_count DESC);

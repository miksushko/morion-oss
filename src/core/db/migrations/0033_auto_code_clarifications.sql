-- Phase 6 MVP — Agent-initiated clarification waits
-- (Morion ticket 01KRG02E2SV2F9F3PZ6TPDDCNA).
--
-- Persists `mo_ask_clarification` MCP tool calls that are mid-flight,
-- waiting for the user to reply in a workflow-linked Ask Mo chat
-- session. The tool runs in the `morion mcp` stdio process spawned by
-- the agent (Pi/Claude/Codex); the chat route lives in the sidecar
-- (`morion serve`). They share this SQLite database — that's the
-- cross-process channel.
--
-- Lifecycle:
--   1. cli_agent stage's MCP tool inserts a row, status='pending',
--      then polls every ~1s for `status='answered'`.
--   2. User replies in the linked concierge_session → chat route
--      (sidecar) UPDATE-s the row: status='answered', answer=<text>.
--   3. MCP tool's next poll sees `answered`, returns the text to the
--      agent, agent continues.
--
-- One pending row per (session_id) at a time — enforced by partial
-- unique index. Multi-turn agents reuse the SAME session_id across
-- questions; the prior row will have already flipped to `answered`
-- before the next question lands.
--
-- All status values:
--   pending     — waiting on user reply
--   answered    — user replied; `answer` is non-null
--   cancelled   — workflow run was cancelled; tool returns error
--   timed_out   — exceeded the hard cap (default 4h cumulative wait)

CREATE TABLE IF NOT EXISTS auto_code_clarifications (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES concierge_sessions(id) ON DELETE CASCADE,
  workflow_run_id   TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  -- Stable id the agent passes back on long-poll retries so the
  -- handler knows NOT to re-post the question to chat. Generated
  -- by the tool on first call when the agent didn't supply one.
  correlation_id    TEXT NOT NULL,
  question          TEXT NOT NULL,
  answer            TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','answered','cancelled','timed_out')),
  registered_at     INTEGER NOT NULL,
  answered_at       INTEGER
);

-- Hot lookup: tool's poll loop queries by session_id (it knows the
-- session_id from the row it just created). Partial index on
-- pending rows keeps the working set tiny.
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_code_clarifications_active
  ON auto_code_clarifications(session_id)
  WHERE status = 'pending';

-- Long-poll path: agent passes back correlation_id on retries, tool
-- looks up the existing row by correlation_id (not session_id —
-- avoids racing with a multi-turn `pending` row).
CREATE INDEX IF NOT EXISTS idx_auto_code_clarifications_correlation
  ON auto_code_clarifications(correlation_id);

-- Chat route's wakeup query joins through session_id → workflow_run_id.
CREATE INDEX IF NOT EXISTS idx_auto_code_clarifications_run
  ON auto_code_clarifications(workflow_run_id, status);

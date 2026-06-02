-- Phase 5 MVP — Human-in-Loop runtime (Morion ticket 01KRFT0742GY480WFJTAW02Z05).
--
-- Adds the persistence backbone for `human_gate` workflow stages:
--
--   * `workflow_runs.paused_session_id` / `paused_at` — when the DAG runner
--     hits a `human_gate` it pauses the run, opens a concierge_sessions
--     row to ask the user, and stores the link here so the resume path
--     can find the conversation cheaply.
--
--   * `concierge_sessions.workflow_run_id` — the reverse link. The chat
--     route reads this on every POST /messages to detect "this user
--     reply belongs to a paused workflow run; trigger resume". ON DELETE
--     SET NULL so deleting a workflow_run doesn't cascade-kill the
--     user's chat history — the conversation remains as a record even
--     after the run is gone.
--
-- All columns NULL by default — back-compat with every existing row.
-- Migrations are forward-only; no rollback path.

ALTER TABLE workflow_runs
  ADD COLUMN paused_session_id TEXT
  REFERENCES concierge_sessions(id) ON DELETE SET NULL;

ALTER TABLE workflow_runs
  ADD COLUMN paused_at INTEGER;

ALTER TABLE concierge_sessions
  ADD COLUMN workflow_run_id TEXT
  REFERENCES workflow_runs(id) ON DELETE SET NULL;

-- Partial index — only paused runs need fast lookup. The active-run
-- index in 0028 covers status='running'/'pending', but
-- `paused_ask_user` rows accumulate and the resume code path queries
-- by status+session_id often enough to want its own index.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_paused_session
  ON workflow_runs(paused_session_id)
  WHERE paused_session_id IS NOT NULL;

-- Mirror index on the sessions side — chat route's POST /messages
-- hot path reads `session.workflow_run_id` per request. Lookup is by
-- session_id (already PRIMARY KEY) but the resume detection in the
-- route handler reads workflow_run_id off the loaded row, so no extra
-- index needed there.

-- Partial index keeps the working set tiny (most sessions are not
-- workflow-linked).
CREATE INDEX IF NOT EXISTS idx_concierge_sessions_workflow_run
  ON concierge_sessions(workflow_run_id)
  WHERE workflow_run_id IS NOT NULL;

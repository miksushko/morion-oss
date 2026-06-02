-- Migration 0029 — widen workflow_run_stages.stage_kind CHECK constraint
-- under the Editor Model v2 spec (Morion note 01KRAQWPXR5AYTFVF6J12TYHJ1).
--
-- Background: 0028 introduced the workflow_runs / workflow_run_stages tables
-- with a stage_kind CHECK that only listed the L2/L3/L4 kinds known at the
-- time: cli_agent / mcp_tool_call / human_gate / branch. The schema-level
-- Zod discriminator has since grown three more kinds — mo_router (deprecated
-- alias for mo_stage, kept for forward-compat with existing canvas drafts),
-- eject (deprecated alias for reject_sink), and the v2 Editor Model trio:
-- mo_stage / reject_sink / complete_sink. The Phase 4 DAG runner will need
-- to persist run-stage rows for those kinds, and would otherwise crash on
-- the CHECK violation at INSERT.
--
-- SQLite CHECK constraints cannot be altered in place. We rebuild the table
-- with the widened CHECK, copy rows, and rename. Indexes are recreated to
-- match 0028's exact shape. The loader wraps each migration in its own
-- transaction (see src/core/db/client.ts), so no explicit BEGIN/COMMIT
-- here; nested BEGINs would fail on better-sqlite3. No other table has an
-- FK pointing to workflow_run_stages.id, so no FK toggle is needed for the
-- rebuild trick.

-- Drop the existing indexes on workflow_run_stages so the rename below
-- doesn't collide. They get rebuilt at the end of the file with the same
-- definitions 0028 created.
DROP INDEX IF EXISTS idx_workflow_run_stages_run;
DROP INDEX IF EXISTS idx_workflow_run_stages_active;
DROP INDEX IF EXISTS idx_workflow_run_stages_run_stage_attempt;

ALTER TABLE workflow_run_stages RENAME TO workflow_run_stages_old_0029;

CREATE TABLE workflow_run_stages (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  stage_id_in_graph TEXT NOT NULL,
  stage_kind        TEXT NOT NULL CHECK (stage_kind IN (
                      'cli_agent',
                      'mcp_tool_call',
                      'human_gate',
                      'branch',
                      'mo_router',
                      'eject',
                      'mo_stage',
                      'reject_sink',
                      'complete_sink'
                    )),
  agent_name        TEXT CHECK (agent_name IS NULL OR agent_name IN (
                      'claude', 'codex', 'pi', 'opencode'
                    )),
  session_id        TEXT,
  transcript_path   TEXT,
  active_pid        INTEGER,
  status            TEXT NOT NULL CHECK (status IN (
                      'pending', 'running', 'cancelled', 'failed', 'done'
                    )),
  attempt           INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  cost_usd          REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  output_json       TEXT,
  last_error        TEXT,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  updated_at        INTEGER NOT NULL
);

INSERT INTO workflow_run_stages (
  id, run_id, stage_id_in_graph, stage_kind, agent_name, session_id,
  transcript_path, active_pid, status, attempt, cost_usd, output_json,
  last_error, started_at, finished_at, updated_at
)
SELECT
  id, run_id, stage_id_in_graph, stage_kind, agent_name, session_id,
  transcript_path, active_pid, status, attempt, cost_usd, output_json,
  last_error, started_at, finished_at, updated_at
FROM workflow_run_stages_old_0029;

DROP TABLE workflow_run_stages_old_0029;

CREATE INDEX idx_workflow_run_stages_run
  ON workflow_run_stages(run_id, started_at);

CREATE INDEX idx_workflow_run_stages_active
  ON workflow_run_stages(status)
  WHERE status IN ('pending', 'running');

CREATE INDEX idx_workflow_run_stages_run_stage_attempt
  ON workflow_run_stages(run_id, stage_id_in_graph, attempt DESC);

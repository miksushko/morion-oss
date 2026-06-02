-- Auto-code Workflow Builder L2.T1a — workflow definitions + runs + stage executions.
--
-- Umbrella:    01KR5F21709BKA6SFHWRFFVVPY (Auto-code Workflow Builder)
-- Design doc:  01KR5TMKE9GZGXTQ2BCTWCXVD5 §4 (L2 spec)
-- Handoff:     01KR6BN48XNQ08H5SMBST7E79A
--
-- Three new tables that own the durable state of every autocode run:
--
--   * `workflows`             — folder-scoped workflow definitions. Empty in v1
--                               (Default Autocode lives as a const in code per
--                               design L2.I3); seeded on L4 when the editor ships.
--   * `workflow_runs`         — one row per autocode invocation. Carries an
--                               immutable `graph_snapshot_json` so edits/deletes
--                               of the parent workflow definition cannot mutate
--                               in-flight runs (design L2.I2).
--   * `workflow_run_stages`   — one row per stage execution attempt within a
--                               run. Same `stage_id_in_graph` can appear N times
--                               (retries / future L4 loops) — `attempt` separates.
--
-- Additive only. Drops of `mo_agent_queue`, `concierge_actions`, and the inert
-- `concierge_folder_settings.workflow` / `schedule_*` columns are deferred to
-- the orchestrator-migration ticket (L2.T7) so the existing autocode loop keeps
-- working until the new runner replaces it. The split is documented in
-- `docs/PLAN.md` under "Auto-code Workflow Builder umbrella".
--
-- No FK from `workflow_runs.workflow_id` to `workflows.id`: in v1 the column is
-- always NULL (hardcoded definition). Adding the FK now would require a
-- placeholder workflows row per folder. We add the column for forward-compat
-- with L4's editor; populate it once definitions move into the DB.

CREATE TABLE IF NOT EXISTS workflows (
  id              TEXT PRIMARY KEY,
  folder_id       TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- JSON-encoded WorkflowDefinition. Linear in v1, DAG from L4.
  definition_json TEXT NOT NULL,
  -- Folder's default workflow for the autocode router (L4). At most one row
  -- per folder should carry is_default=1; enforcement is at the repository
  -- layer until the router lands.
  is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflows_folder
  ON workflows(folder_id, is_default DESC, name);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                  TEXT PRIMARY KEY,
  -- Nullable: v1 runs use the hardcoded Default Autocode; populated from L4
  -- when definitions move into the DB. Intentionally NOT a FK — see header.
  workflow_id         TEXT,
  folder_id           TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  ticket_id           TEXT NOT NULL REFERENCES notes(id)   ON DELETE CASCADE,
  -- Immutable snapshot of the workflow definition at the moment the run
  -- started. Edits/deletes of the parent workflow do not retroactively alter
  -- in-flight runs (design L2.I2).
  graph_snapshot_json TEXT NOT NULL,
  -- Snapshot of the linked git repo + worktree path at run start. Without
  -- this a resumed runner (T6) would re-read mutable folder settings and
  -- could end up pointing at a different checkout after the user changes
  -- the repo path mid-flight, or fail to clean up an old worktree whose
  -- naming convention drifted in code. Required (every cli_agent stage
  -- needs both); future non-cli_agent stages may relax to NULL but not yet.
  repo_path           TEXT NOT NULL,
  worktree_path       TEXT NOT NULL,
  -- pending | running | paused_ask_user | cancelled | failed | done
  -- `paused_ask_user` is reserved for L3; runner only writes the other five.
  -- CHECK constrained so a typo or raw SQL write fails loudly instead of
  -- silently dropping the row out of the active partial index.
  status              TEXT NOT NULL CHECK (status IN (
                        'pending', 'running', 'paused_ask_user',
                        'cancelled', 'failed', 'done'
                      )),
  -- Snapshot stage id currently executing. NULL when the run is terminal.
  current_stage_id    TEXT,
  -- Toggle-off / explicit cancel sets this to 1; the runner observes between
  -- stages and on the next adapter event tick.
  cancel_requested    INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  total_cost_usd      REAL NOT NULL DEFAULT 0 CHECK (total_cost_usd >= 0),
  last_error          TEXT,
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER,
  updated_at          INTEGER NOT NULL
);

-- UI: list runs for a single ticket newest-first (kanban badge, drawer).
CREATE INDEX IF NOT EXISTS idx_workflow_runs_ticket
  ON workflow_runs(ticket_id, started_at DESC);

-- Per-folder dashboard + cap-check (folder run concurrency invariant L1.I cross-layer #5).
CREATE INDEX IF NOT EXISTS idx_workflow_runs_folder_status
  ON workflow_runs(folder_id, status, started_at DESC);

-- Resume sweep on app restart: every non-terminal run.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_active
  ON workflow_runs(status)
  WHERE status IN ('pending', 'running', 'paused_ask_user');

-- Coalescing primitive: at most one in-flight run per (folder, ticket).
-- Mirrors the legacy `mo_agent_queue` partial unique index. A double-trigger,
-- restart race, or two runner instances all collapse onto a single active
-- row instead of spawning competing worktrees/agents. Terminal rows
-- accumulate as history; a fresh enqueue against a ticket whose only rows
-- are terminal succeeds.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_active_unique
  ON workflow_runs(folder_id, ticket_id)
  WHERE status NOT IN ('cancelled', 'failed', 'done');

CREATE TABLE IF NOT EXISTS workflow_run_stages (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  -- Snapshot stage id (NOT a workflows.stages FK — graph_snapshot_json is
  -- the source of truth). Same stage_id_in_graph appears multiple times
  -- across attempts. Uniqueness within a snapshot is enforced at the Zod
  -- layer when the snapshot is parsed.
  stage_id_in_graph TEXT NOT NULL,
  -- cli_agent | mcp_tool_call | human_gate | branch
  -- v1 only writes cli_agent; the others are reserved for L3 / L4.
  stage_kind        TEXT NOT NULL CHECK (stage_kind IN (
                      'cli_agent', 'mcp_tool_call', 'human_gate', 'branch'
                    )),
  -- For cli_agent stages: which adapter spawned. NULL for non-cli_agent kinds.
  agent_name        TEXT CHECK (agent_name IS NULL OR agent_name IN (
                      'claude', 'codex', 'pi', 'opencode'
                    )),
  -- Adapter session id (claude `--session-id`, pi `--session`, etc.). Used by
  -- resume-supported adapters when L3 reattaches after ask_user.
  session_id        TEXT,
  -- Path to JSONL transcript on disk (L1 transcript persistence).
  transcript_path   TEXT,
  -- Live OS pid while the stage is running; cleared on terminal state. Used
  -- by the toggle-off killer to SIGTERM in-flight work.
  active_pid        INTEGER,
  -- pending | running | cancelled | failed | done
  status            TEXT NOT NULL CHECK (status IN (
                      'pending', 'running', 'cancelled', 'failed', 'done'
                    )),
  -- Retry counter. Re-running stage_id_in_graph N times produces N rows with
  -- attempt=1..N; the runner picks max(attempt) when computing next attempt.
  attempt           INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  cost_usd          REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  -- Structured stage output (verdict, diff path, agent answer JSON, branch
  -- decision). Adapter-shaped — runner consumers parse per stage_kind.
  output_json       TEXT,
  last_error        TEXT,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  updated_at        INTEGER NOT NULL
);

-- Drawer rendering: every stage of a run in execution order.
CREATE INDEX IF NOT EXISTS idx_workflow_run_stages_run
  ON workflow_run_stages(run_id, started_at);

-- Stale-claim recovery: every non-terminal stage row.
CREATE INDEX IF NOT EXISTS idx_workflow_run_stages_active
  ON workflow_run_stages(status)
  WHERE status IN ('pending', 'running');

-- Fast lookup of latest attempt for (run_id, stage_id_in_graph) — used when
-- the runner advances to a new attempt of the same snapshot stage.
CREATE INDEX IF NOT EXISTS idx_workflow_run_stages_run_stage_attempt
  ON workflow_run_stages(run_id, stage_id_in_graph, attempt DESC);

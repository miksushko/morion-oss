-- Scheduler Phase 1 — workflow_schedules table.
--
-- Umbrella:  01KSX1WJF0TR6949TDQS7Z1TXS (Scheduler — cron + cross-MCP chains)
-- Goal:      add the persistent storage layer for cron-triggered workflow
--            runs. NO changes to workflow_runs yet — actual dispatch via
--            WorkflowRunner is Phase 1d (requires ticket_id nullable +
--            dispatchScheduled() entry point on the runner). This file
--            ships ONLY the table + indexes; Phase 1c scheduler-tick code
--            stamps last_run_at without yet inserting workflow_runs rows.
--
-- Shape:
--   id              ULID
--   folder_id       FK to folders(id), CASCADE on delete — schedules are
--                   per-folder for symmetry with workflows (a kanban-mode
--                   folder owns its workflows, and the scheduled triggers
--                   for them, together).
--   workflow_id     FK shape mirrors `workflow_runs.workflow_id` —
--                   nullable + not enforced — so v1 hardcoded-default
--                   autocode can be scheduled before workflows table is
--                   populated. Once L4 lands every schedule will reference
--                   a workflows row.
--   cron_expr       5-field cron string ("0 9 * * 1-5" / "*/15 * * * *").
--                   Validated at the repository layer via the cron
--                   parser; DB stores raw text.
--   enabled         INTEGER 0/1, default 1. Disabled schedules are
--                   skipped by the scheduler tick — kept in the table
--                   so the user can re-enable without re-creating.
--   last_run_at     Epoch-ms of the last successful tick fire. Null
--                   until first fire. Drives double-fire prevention:
--                   the tick refuses to fire a schedule if last_run_at
--                   is within the same minute as `now`.
--   last_run_status One of "pending" | "running" | "done" | "failed" |
--                   "skipped" — denormalised copy of the most recent
--                   workflow_runs row's status (Phase 1d wires this).
--                   Stored as TEXT for forward-compat (other statuses
--                   may appear later). Null when last_run_at is null.
--   created_at,
--   updated_at      Standard epoch-ms timestamps.
--
-- Indexes:
--   * (folder_id, enabled)  — most-frequent listDue() shape: load all
--     enabled schedules for active folders. Tick iterates this index.
--   * (workflow_id)         — for cascading cleanup when a workflow row
--     is deleted (Phase 2 UI will offer per-workflow deletion).

CREATE TABLE IF NOT EXISTS workflow_schedules (
  id               TEXT PRIMARY KEY,
  folder_id        TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  workflow_id      TEXT,
  cron_expr        TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_run_at      INTEGER,
  last_run_status  TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_schedules_folder_enabled
  ON workflow_schedules(folder_id, enabled);

CREATE INDEX IF NOT EXISTS idx_workflow_schedules_workflow
  ON workflow_schedules(workflow_id)
  WHERE workflow_id IS NOT NULL;

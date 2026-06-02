-- Scheduler Phase 1d-A — workflow_runs.schedule_id back-reference.
--
-- Umbrella: 01KSX1WJF0TR6949TDQS7Z1TXS (Scheduler — cron + cross-MCP chains).
--
-- Adds a nullable FK from `workflow_runs` back to `workflow_schedules`
-- so each scheduled invocation carries the schedule that fired it.
-- Used by:
--
--   * Phase 1d-B `dispatchScheduled()` — stamps schedule_id when the
--     scheduler tick fires a run.
--   * Phase 2 UI — "show all runs of this schedule" history view
--     joins workflow_runs to workflow_schedules on schedule_id.
--
-- ON DELETE SET NULL (not CASCADE) — deleting a schedule should
-- preserve its historical runs as un-attributed records. Same shape
-- as `concierge_sessions.workflow_run_id` (0032).
--
-- Additive only. workflow_runs.ticket_id keeps its NOT NULL +
-- CASCADE for now; scheduled runs use a synthetic ticket-note in
-- the folder to satisfy the constraint (the synthetic note carries
-- `source = 'mo:schedule'` so the standard mo:* filter hides it
-- from user-facing lists/search). Future migration can relax
-- ticket_id NOT NULL once we're confident no other surface depends
-- on every run having a real ticket.

ALTER TABLE workflow_runs
  ADD COLUMN schedule_id TEXT
  REFERENCES workflow_schedules(id) ON DELETE SET NULL;

-- Partial index — only scheduled runs need fast lookup by schedule.
-- The vast majority of workflow_runs rows are kanban-bound and
-- carry NULL schedule_id; a partial index keeps the working set
-- tiny + makes "this schedule's run history" sub-millisecond.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_schedule
  ON workflow_runs(schedule_id, started_at DESC)
  WHERE schedule_id IS NOT NULL;

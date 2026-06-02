-- Migration 0030 — workflow_runs.merged_at
--
-- Tracks when (or whether) the per-run worktree branch was merged
-- into the user's main checkout via the "Merge into main" UI button
-- (AutoCodeDrawer). NULL = not merged. INTEGER (ms epoch) = the time
-- the successful `git merge` returned.
--
-- Surfaced through the kanban-card badge as a separate
-- `done_merged` AutoCodeQueueState — distinguishes "auto-code
-- finished, code lives on a feature branch" from "auto-code
-- finished AND the code is now on main". Without this the
-- "Merge into main" button stays visible after a successful merge,
-- inviting an idempotent re-merge that surfaces as a confusing
-- "Already up to date" message.

ALTER TABLE workflow_runs ADD COLUMN merged_at INTEGER;

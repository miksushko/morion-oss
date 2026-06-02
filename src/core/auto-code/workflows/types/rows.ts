import { z } from 'zod';
import type { StageKind } from './stage-kind.js';
import type { CliAgentName } from './stages/cli-agent.js';
import type { WorkflowDefinition } from './definition.js';

// --- Workflow row (DB) --------------------------------------------------

export interface WorkflowRow {
  id: string;
  folderId: string;
  name: string;
  /** Parsed `definition_json` — callers receive the validated object, not
   *  the raw string. The repository handles JSON.parse + Zod validation. */
  definition: WorkflowDefinition;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

// --- Workflow run row (DB) ----------------------------------------------

export const WorkflowRunStatusSchema = z.enum([
  'pending',
  'running',
  'paused_ask_user',
  'cancelled',
  'failed',
  'done',
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  'cancelled',
  'failed',
  'done',
]);

export const ACTIVE_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  'pending',
  'running',
  'paused_ask_user',
]);

export interface WorkflowRunRow {
  id: string;
  workflowId: string | null;
  folderId: string;
  ticketId: string;
  /** Parsed snapshot. Immutable — see header of migration 0028. */
  graphSnapshot: WorkflowDefinition;
  /** Snapshot of the linked git repo absolute path at run start. */
  repoPath: string;
  /** Snapshot of the per-run git worktree absolute path. */
  worktreePath: string;
  status: WorkflowRunStatus;
  currentStageId: string | null;
  cancelRequested: boolean;
  totalCostUsd: number;
  lastError: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** Set to ms-epoch when the user merged this run's worktree branch
   *  into their main checkout via the AutoCodeDrawer "Merge into main"
   *  button. NULL = not merged. The kanban badge promotes the row
   *  from `done` → `done_merged` once non-null so the user can
   *  distinguish "agent finished, code is on a feature branch" from
   *  "agent finished AND code is in main". Persisted via migration 0030. */
  mergedAt: number | null;
  /** Phase 5 (migration 0032) — when the DAG runner hits a `human_gate`
   *  stage it pauses the run, creates a concierge_sessions row, and
   *  stores the session id here. NULL on all non-paused runs and on
   *  any run that has never paused. Cleared back to NULL on resume. */
  pausedSessionId: string | null;
  /** Phase 5 (migration 0032) — ms-epoch when the run last paused for
   *  human input. Set together with `pausedSessionId`; cleared on
   *  resume. Useful for "auto-abandon after N hours" later (out of
   *  scope for MVP). */
  pausedAt: number | null;
  /** Scheduler Phase 1d-A (migration 0041) — the schedule that fired
   *  this run, when it was a cron-triggered invocation. NULL on every
   *  user-driven kanban run. ON DELETE SET NULL so deleting a
   *  schedule preserves its historical runs as orphan rows (history
   *  > strict referential integrity here). Phase 2 UI joins on this
   *  for "show all runs of this schedule" lookup. */
  scheduleId: string | null;
  updatedAt: number;
}

// --- Workflow run stage row (DB) ----------------------------------------

export const WorkflowStageStatusSchema = z.enum([
  'pending',
  'running',
  'cancelled',
  'failed',
  'done',
]);
export type WorkflowStageStatus = z.infer<typeof WorkflowStageStatusSchema>;

export const TERMINAL_STAGE_STATUSES: ReadonlySet<WorkflowStageStatus> = new Set([
  'cancelled',
  'failed',
  'done',
]);

export interface WorkflowRunStageRow {
  id: string;
  runId: string;
  stageIdInGraph: string;
  stageKind: StageKind;
  agentName: CliAgentName | null;
  sessionId: string | null;
  transcriptPath: string | null;
  activePid: number | null;
  status: WorkflowStageStatus;
  attempt: number;
  costUsd: number;
  /** Parsed stage output. Adapter-shaped per stage_kind. */
  output: Record<string, unknown> | null;
  lastError: string | null;
  startedAt: number;
  finishedAt: number | null;
  updatedAt: number;
}

import type {
  CliAgentName,
  StageKind,
  WorkflowDefinition,
  WorkflowRunRow,
  WorkflowRunStatus,
  WorkflowStageStatus,
} from '../types/index.js';

/**
 * Public input/output types for the workflow runs repository.
 * Extracted from runs-repository.ts during the 2026-05-16 split
 * (Morion ticket 01KRQYS65NPPXFBNW6EYT99NXH).
 */

export interface CreateRunInput {
  folderId: string;
  ticketId: string;
  workflowId?: string | null;
  graphSnapshot: WorkflowDefinition;
  /** Linked git repo absolute path. Snapshot at run-start so a resumed
   *  runner doesn't re-read the (possibly mutated) folder setting. */
  repoPath: string;
  /** Per-run git worktree absolute path. Snapshot for the same reason +
   *  so cleanup can find old worktrees even if the naming convention
   *  drifts in code. */
  worktreePath: string;
  initialStatus?: WorkflowRunStatus;
  /** Scheduler Phase 1d-A — when this run was triggered by a cron
   *  schedule, the firing workflow_schedules.id. Null on every
   *  kanban-card-triggered run. Persisted via migration 0041. */
  scheduleId?: string | null;
}

export interface CreateRunResult {
  run: WorkflowRunRow;
  /** True iff an active run already existed for (folderId, ticketId) and
   *  this call returned that row instead of inserting a new one. The
   *  partial unique index `idx_workflow_runs_active_unique` enforces the
   *  invariant at the DB layer; the repo collapses the race to a clean
   *  return. */
  deduped: boolean;
}

export interface CreateStageInput {
  runId: string;
  stageIdInGraph: string;
  stageKind: StageKind;
  agentName?: CliAgentName | null;
  sessionId?: string | null;
  transcriptPath?: string | null;
  attempt?: number;
  initialStatus?: WorkflowStageStatus;
}

export interface UpdateRunInput {
  status?: WorkflowRunStatus;
  currentStageId?: string | null;
  cancelRequested?: boolean;
  totalCostUsd?: number;
  lastError?: string | null;
  finishedAt?: number | null;
}

export interface UpdateStageInput {
  status?: WorkflowStageStatus;
  agentName?: CliAgentName | null;
  sessionId?: string | null;
  transcriptPath?: string | null;
  activePid?: number | null;
  costUsd?: number;
  output?: Record<string, unknown> | null;
  lastError?: string | null;
  finishedAt?: number | null;
}

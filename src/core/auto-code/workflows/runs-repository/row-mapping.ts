import {
  type CliAgentName,
  type StageKind,
  WorkflowDefinitionSchema,
  type WorkflowRunRow,
  type WorkflowRunStageRow,
  type WorkflowRunStatus,
  type WorkflowStageStatus,
} from '../types/index.js';

/**
 * SQLite row interfaces + camelCase mappers for the workflow runs
 * repository. Extracted from runs-repository.ts during the 2026-05-16
 * split (Morion ticket 01KRQYS65NPPXFBNW6EYT99NXH).
 */

export interface RunRow {
  id: string;
  workflow_id: string | null;
  folder_id: string;
  ticket_id: string;
  graph_snapshot_json: string;
  repo_path: string;
  worktree_path: string;
  status: string;
  current_stage_id: string | null;
  cancel_requested: number;
  total_cost_usd: number;
  last_error: string | null;
  started_at: number;
  finished_at: number | null;
  /** Migration 0030 — set once the user merges this run's worktree
   *  branch into their main checkout via the AutoCodeDrawer button. */
  merged_at: number | null;
  /** Migration 0032 — Phase 5 Human-in-Loop pause state. */
  paused_session_id: string | null;
  paused_at: number | null;
  /** Migration 0041 — Scheduler Phase 1d. NULL for kanban runs;
   *  set to the firing workflow_schedules row id for cron runs. */
  schedule_id: string | null;
  updated_at: number;
}

export interface StageRow {
  id: string;
  run_id: string;
  stage_id_in_graph: string;
  stage_kind: string;
  agent_name: string | null;
  session_id: string | null;
  transcript_path: string | null;
  active_pid: number | null;
  status: string;
  attempt: number;
  cost_usd: number;
  output_json: string | null;
  last_error: string | null;
  started_at: number;
  finished_at: number | null;
  updated_at: number;
}

export function rowToRun(row: RunRow): WorkflowRunRow {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    folderId: row.folder_id,
    ticketId: row.ticket_id,
    // Validate on read — a corrupt snapshot is a bug we want to surface
    // immediately (failing parse) rather than handing callers an `unknown`.
    graphSnapshot: WorkflowDefinitionSchema.parse(JSON.parse(row.graph_snapshot_json)),
    repoPath: row.repo_path,
    worktreePath: row.worktree_path,
    status: row.status as WorkflowRunStatus,
    currentStageId: row.current_stage_id,
    cancelRequested: row.cancel_requested === 1,
    totalCostUsd: row.total_cost_usd,
    lastError: row.last_error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    mergedAt: row.merged_at,
    pausedSessionId: row.paused_session_id,
    pausedAt: row.paused_at,
    scheduleId: row.schedule_id,
    updatedAt: row.updated_at,
  };
}

export function rowToStage(row: StageRow): WorkflowRunStageRow {
  return {
    id: row.id,
    runId: row.run_id,
    stageIdInGraph: row.stage_id_in_graph,
    stageKind: row.stage_kind as StageKind,
    agentName: row.agent_name as CliAgentName | null,
    sessionId: row.session_id,
    transcriptPath: row.transcript_path,
    activePid: row.active_pid,
    status: row.status as WorkflowStageStatus,
    attempt: row.attempt,
    costUsd: row.cost_usd,
    output: row.output_json ? JSON.parse(row.output_json) : null,
    lastError: row.last_error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

export function isUniqueConstraint(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

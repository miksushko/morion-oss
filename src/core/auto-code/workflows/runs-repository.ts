import type Database from 'better-sqlite3';

import type { WorkflowRunRow, WorkflowRunStageRow } from './types/index.js';
import * as queries from './runs-repository/runs-queries.js';
import * as mutations from './runs-repository/runs-mutations.js';
import * as stages from './runs-repository/stages.js';
import type {
  CreateRunInput,
  CreateRunResult,
  CreateStageInput,
  UpdateRunInput,
  UpdateStageInput,
} from './runs-repository/inputs.js';

/**
 * CRUD for `workflow_runs` + `workflow_run_stages` (migration 0028).
 *
 * Scope is L2.T1a — schema + thin persistence. State-machine semantics
 * (which transitions are legal, when to mark `failed` vs `cancelled`,
 * stale-claim recovery) live in `WorkflowRunner` shipped under L2.T4.
 *
 * Module layout — per the 2026-05-16 split (Morion ticket
 * 01KRQYS65NPPXFBNW6EYT99NXH). Public surface is this class; the body
 * is thin delegation to per-domain function modules so each leaf stays
 * under the 300-LOC ticket target:
 *
 *   - `./runs-repository/row-mapping.ts`    RunRow/StageRow + rowToRun
 *                                            + rowToStage + isUniqueConstraint.
 *   - `./runs-repository/inputs.ts`         CreateRunInput / CreateStageInput
 *                                            + Update*Input + CreateRunResult.
 *   - `./runs-repository/runs-queries.ts`   read paths for workflow_runs.
 *   - `./runs-repository/runs-mutations.ts` write paths + pause/resume.
 *   - `./runs-repository/stages.ts`         CRUD for workflow_run_stages.
 *
 * Re-exports preserve the pre-split public surface verbatim.
 */
export type {
  CreateRunInput,
  CreateRunResult,
  CreateStageInput,
  UpdateRunInput,
  UpdateStageInput,
} from './runs-repository/inputs.js';

export class WorkflowRunsRepository {
  constructor(private readonly db: Database.Database) {}

  // ---- runs --------------------------------------------------------

  createRun(input: CreateRunInput, now?: number): CreateRunResult {
    return mutations.createRun(this.db, input, now);
  }

  findActiveRunForTicket(folderId: string, ticketId: string): WorkflowRunRow | null {
    return queries.findActiveRunForTicket(this.db, folderId, ticketId);
  }

  getRun(id: string): WorkflowRunRow | null {
    return queries.getRun(this.db, id);
  }

  listRunsForTicket(ticketId: string, limit: number = 50): WorkflowRunRow[] {
    return queries.listRunsForTicket(this.db, ticketId, limit);
  }

  /** All non-terminal runs across all folders. Used by the runner's
   *  app-startup resume sweep (L2.T6). */
  listActiveRuns(): WorkflowRunRow[] {
    return queries.listActiveRuns(this.db);
  }

  countActiveRunsInFolder(folderId: string): number {
    return queries.countActiveRunsInFolder(this.db, folderId);
  }

  /** All runs for one ticket, newest first. Mirrors
   *  `AgentQueueRepository.listForTask` so the AutoCodeDrawer's run
   *  picker can union both engines. */
  listForTicket(ticketId: string, limit = 50): WorkflowRunRow[] {
    return queries.listRunsForTicket(this.db, ticketId, limit);
  }

  /** Latest run per ticket id across the input list. */
  listLatestForTasks(taskIds: string[]): Map<string, WorkflowRunRow> {
    return queries.listLatestForTasks(this.db, taskIds);
  }

  /** Active (non-terminal) runs scoped to one folder. */
  listActiveRunsInFolder(folderId: string): WorkflowRunRow[] {
    return queries.listActiveRunsInFolder(this.db, folderId);
  }

  updateRun(id: string, patch: UpdateRunInput, now?: number): void {
    mutations.updateRun(this.db, id, patch, now);
  }

  /** Stamp `merged_at` (idempotent — only set when null). */
  markMerged(id: string, now?: number): void {
    mutations.markMerged(this.db, id, now);
  }

  /** Phase 5 — flip into `paused_ask_user`. Returns false when the
   *  WHERE guard didn't match (already cancelled / terminal). */
  pauseForHumanGate(
    args: { runId: string; sessionId: string; humanGateStageId: string },
    now?: number,
  ): boolean {
    return mutations.pauseForHumanGate(this.db, args, now);
  }

  /** Phase 5 — flip back to `running`. Returns the post-flip row, or
   *  null when the WHERE didn't match. */
  resumeFromHumanGate(runId: string, now?: number): WorkflowRunRow | null {
    return mutations.resumeFromHumanGate(this.db, runId, now);
  }

  /** Phase 5 — read every run currently paused for human input. */
  listPausedRuns(): WorkflowRunRow[] {
    return queries.listPausedRuns(this.db);
  }

  // ---- stages ------------------------------------------------------

  createStage(input: CreateStageInput, now?: number): WorkflowRunStageRow {
    return stages.createStage(this.db, input, now);
  }

  getStage(id: string): WorkflowRunStageRow | null {
    return stages.getStage(this.db, id);
  }

  listStagesForRun(runId: string): WorkflowRunStageRow[] {
    return stages.listStagesForRun(this.db, runId);
  }

  /** Highest `attempt` row for `(runId, stageIdInGraph)`. */
  latestAttemptForStage(
    runId: string,
    stageIdInGraph: string,
  ): WorkflowRunStageRow | null {
    return stages.latestAttemptForStage(this.db, runId, stageIdInGraph);
  }

  updateStage(id: string, patch: UpdateStageInput, now?: number): void {
    stages.updateStage(this.db, id, patch, now);
  }
}

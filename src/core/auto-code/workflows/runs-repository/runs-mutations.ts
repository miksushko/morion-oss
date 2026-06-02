import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import {
  TERMINAL_RUN_STATUSES,
  WorkflowDefinitionSchema,
  type WorkflowRunRow,
} from '../types/index.js';
import { isUniqueConstraint } from './row-mapping.js';
import type { CreateRunInput, CreateRunResult, UpdateRunInput } from './inputs.js';
import { findActiveRunForTicket, getRun } from './runs-queries.js';

/**
 * Write-side mutations for `workflow_runs` — create + update +
 * merge-stamp + pause/resume for human gate. Extracted from
 * runs-repository.ts during the 2026-05-16 split (Morion ticket
 * 01KRQYS65NPPXFBNW6EYT99NXH).
 */

/**
 * Create a new active run, OR return the existing active run for
 * `(folderId, ticketId)` if one is already in flight. Wrapped in a
 * SQLite immediate transaction so the precheck + INSERT race against
 * concurrent runners collapses safely — if the INSERT loses the race
 * to the partial unique index, a re-SELECT returns the winner.
 *
 * Callers should branch on `deduped` when they want to surface "we
 * joined an existing run" semantics in the UI / audit log.
 */
export function createRun(
  db: Database.Database,
  input: CreateRunInput,
  now: number = Date.now(),
): CreateRunResult {
  // Validate before persisting — better to fail loud at write than to
  // surface a corrupt snapshot to a runner attempting to dispatch stages.
  const snapshot = WorkflowDefinitionSchema.parse(input.graphSnapshot);
  const id = ulid();
  const initialStatus = input.initialStatus ?? 'pending';

  const tx = db.transaction((): { id: string; deduped: boolean } => {
    // Active-run precheck. If the requested initial status is already
    // terminal (rare — caller seeding a "done" row for tests), skip
    // dedupe and just insert.
    if (!TERMINAL_RUN_STATUSES.has(initialStatus)) {
      const existing = findActiveRunForTicket(db, input.folderId, input.ticketId);
      if (existing) {
        return { id: existing.id, deduped: true };
      }
    }
    try {
      db
        .prepare(
          `INSERT INTO workflow_runs (
             id, workflow_id, folder_id, ticket_id, graph_snapshot_json,
             repo_path, worktree_path,
             status, current_stage_id, cancel_requested, total_cost_usd,
             last_error, started_at, finished_at, updated_at,
             schedule_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, NULL, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          input.workflowId ?? null,
          input.folderId,
          input.ticketId,
          JSON.stringify(snapshot),
          input.repoPath,
          input.worktreePath,
          initialStatus,
          now,
          now,
          input.scheduleId ?? null,
        );
      return { id, deduped: false };
    } catch (err) {
      // Concurrent runner won the race — partial unique index rejected.
      // Fall through to the existing active row.
      if (isUniqueConstraint(err)) {
        const existing = findActiveRunForTicket(db, input.folderId, input.ticketId);
        if (existing) return { id: existing.id, deduped: true };
      }
      throw err;
    }
  });

  const { id: resultId, deduped } = tx();
  const run = getRun(db, resultId);
  if (!run) throw new Error('createRun: row vanished post-insert');
  return { run, deduped };
}

export function updateRun(
  db: Database.Database,
  id: string,
  patch: UpdateRunInput,
  now: number = Date.now(),
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.currentStageId !== undefined) {
    sets.push('current_stage_id = ?');
    params.push(patch.currentStageId);
  }
  if (patch.cancelRequested !== undefined) {
    sets.push('cancel_requested = ?');
    params.push(patch.cancelRequested ? 1 : 0);
  }
  if (patch.totalCostUsd !== undefined) {
    sets.push('total_cost_usd = ?');
    params.push(patch.totalCostUsd);
  }
  if (patch.lastError !== undefined) {
    sets.push('last_error = ?');
    params.push(patch.lastError);
  }
  if (patch.finishedAt !== undefined) {
    sets.push('finished_at = ?');
    params.push(patch.finishedAt);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(now);
  params.push(id);
  db
    .prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);
}

/** Stamp `merged_at` (and bump `updated_at`) when the user merges
 *  this run's worktree branch into main via the AutoCodeDrawer
 *  affordance. Idempotent — `merged_at` only gets stamped when
 *  null, so a double-click on Merge won't smear the timestamp. */
export function markMerged(
  db: Database.Database,
  id: string,
  now: number = Date.now(),
): void {
  db
    .prepare(
      `UPDATE workflow_runs
          SET merged_at = ?, updated_at = ?
        WHERE id = ?
          AND merged_at IS NULL`,
    )
    .run(now, now, id);
}

/** Phase 5 — flip the run into `paused_ask_user`, stamp the linked
 *  concierge session id + the human_gate stage id we paused at. Returns
 *  true when the update landed (the run was actually running),
 *  false when it didn't match the WHERE — concurrent cancel / terminal
 *  state already locked the row. The status guard is the cheap atomic
 *  contract: caller MUST tolerate a `false` return as "the run is no
 *  longer waiting for me, drop the pause silently". */
export function pauseForHumanGate(
  db: Database.Database,
  args: { runId: string; sessionId: string; humanGateStageId: string },
  now: number = Date.now(),
): boolean {
  const r = db
    .prepare(
      `UPDATE workflow_runs
          SET status = 'paused_ask_user',
              current_stage_id = ?,
              paused_session_id = ?,
              paused_at = ?,
              updated_at = ?
        WHERE id = ?
          AND status IN ('running','pending')
          AND cancel_requested = 0`,
    )
    .run(args.humanGateStageId, args.sessionId, now, now, args.runId);
  return r.changes === 1;
}

/** Phase 5 — flip the run back to `running` and clear pause metadata.
 *  Idempotent contract: callers can fire this from the chat-route hook
 *  fire-and-forget; the WHERE clause guards against double-flip when
 *  two user messages land in the same millisecond.
 *
 *  Returns the row AFTER the flip (so the runner has the fresh state
 *  for the dispatch walk) when the flip landed; null when the WHERE
 *  didn't match (already-resumed, cancelled, finished). */
export function resumeFromHumanGate(
  db: Database.Database,
  runId: string,
  now: number = Date.now(),
): WorkflowRunRow | null {
  const r = db
    .prepare(
      `UPDATE workflow_runs
          SET status = 'running',
              paused_session_id = NULL,
              paused_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND status = 'paused_ask_user'`,
    )
    .run(now, runId);
  if (r.changes !== 1) return null;
  return getRun(db, runId);
}

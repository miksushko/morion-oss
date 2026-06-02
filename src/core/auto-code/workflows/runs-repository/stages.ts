import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type { WorkflowRunStageRow } from '../types/index.js';
import { rowToStage, type StageRow } from './row-mapping.js';
import type { CreateStageInput, UpdateStageInput } from './inputs.js';

/**
 * CRUD for `workflow_run_stages`. Extracted from runs-repository.ts
 * during the 2026-05-16 split (Morion ticket
 * 01KRQYS65NPPXFBNW6EYT99NXH).
 */

export function createStage(
  db: Database.Database,
  input: CreateStageInput,
  now: number = Date.now(),
): WorkflowRunStageRow {
  const id = ulid();
  db
    .prepare(
      `INSERT INTO workflow_run_stages (
         id, run_id, stage_id_in_graph, stage_kind, agent_name,
         session_id, transcript_path, active_pid, status, attempt,
         cost_usd, output_json, last_error, started_at, finished_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, NULL, NULL, ?, NULL, ?)`,
    )
    .run(
      id,
      input.runId,
      input.stageIdInGraph,
      input.stageKind,
      input.agentName ?? null,
      input.sessionId ?? null,
      input.transcriptPath ?? null,
      input.initialStatus ?? 'pending',
      input.attempt ?? 1,
      now,
      now,
    );
  const row = getStage(db, id);
  if (!row) throw new Error('createStage: row vanished post-insert');
  return row;
}

export function getStage(db: Database.Database, id: string): WorkflowRunStageRow | null {
  const row = db
    .prepare<[string], StageRow>('SELECT * FROM workflow_run_stages WHERE id = ?')
    .get(id);
  return row ? rowToStage(row) : null;
}

export function listStagesForRun(
  db: Database.Database,
  runId: string,
): WorkflowRunStageRow[] {
  const rows = db
    .prepare<[string], StageRow>(
      `SELECT * FROM workflow_run_stages
        WHERE run_id = ?
        ORDER BY started_at ASC, id ASC`,
    )
    .all(runId);
  return rows.map(rowToStage);
}

/** Highest `attempt` row for `(runId, stageIdInGraph)`. Used when the
 *  runner advances to attempt N+1 of the same snapshot stage. */
export function latestAttemptForStage(
  db: Database.Database,
  runId: string,
  stageIdInGraph: string,
): WorkflowRunStageRow | null {
  const row = db
    .prepare<[string, string], StageRow>(
      `SELECT * FROM workflow_run_stages
        WHERE run_id = ? AND stage_id_in_graph = ?
        ORDER BY attempt DESC
        LIMIT 1`,
    )
    .get(runId, stageIdInGraph);
  return row ? rowToStage(row) : null;
}

export function updateStage(
  db: Database.Database,
  id: string,
  patch: UpdateStageInput,
  now: number = Date.now(),
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.agentName !== undefined) {
    sets.push('agent_name = ?');
    params.push(patch.agentName);
  }
  if (patch.sessionId !== undefined) {
    sets.push('session_id = ?');
    params.push(patch.sessionId);
  }
  if (patch.transcriptPath !== undefined) {
    sets.push('transcript_path = ?');
    params.push(patch.transcriptPath);
  }
  if (patch.activePid !== undefined) {
    sets.push('active_pid = ?');
    params.push(patch.activePid);
  }
  if (patch.costUsd !== undefined) {
    sets.push('cost_usd = ?');
    params.push(patch.costUsd);
  }
  if (patch.output !== undefined) {
    sets.push('output_json = ?');
    params.push(patch.output ? JSON.stringify(patch.output) : null);
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
    .prepare(`UPDATE workflow_run_stages SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);
}

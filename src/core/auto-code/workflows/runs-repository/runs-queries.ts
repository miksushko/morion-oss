import type Database from 'better-sqlite3';
import { ACTIVE_RUN_STATUSES, type WorkflowRunRow } from '../types/index.js';
import { rowToRun, type RunRow } from './row-mapping.js';

/**
 * Read-side queries for `workflow_runs`. Extracted from
 * runs-repository.ts during the 2026-05-16 split (Morion ticket
 * 01KRQYS65NPPXFBNW6EYT99NXH).
 */

/**
 * Returns the unique active (non-terminal) run for `(folderId, ticketId)`
 * if any. The partial unique index makes "at most one" a DB-level
 * guarantee — if multiple rows are returned the schema is corrupt.
 */
export function findActiveRunForTicket(
  db: Database.Database,
  folderId: string,
  ticketId: string,
): WorkflowRunRow | null {
  const placeholders = [...ACTIVE_RUN_STATUSES].map(() => '?').join(',');
  const row = db
    .prepare<unknown[], RunRow>(
      `SELECT * FROM workflow_runs
        WHERE folder_id = ? AND ticket_id = ?
          AND status IN (${placeholders})`,
    )
    .get(folderId, ticketId, ...ACTIVE_RUN_STATUSES);
  return row ? rowToRun(row) : null;
}

export function getRun(db: Database.Database, id: string): WorkflowRunRow | null {
  const row = db
    .prepare<[string], RunRow>('SELECT * FROM workflow_runs WHERE id = ?')
    .get(id);
  return row ? rowToRun(row) : null;
}

export function listRunsForTicket(
  db: Database.Database,
  ticketId: string,
  limit: number = 50,
): WorkflowRunRow[] {
  const rows = db
    .prepare<[string, number], RunRow>(
      `SELECT * FROM workflow_runs
        WHERE ticket_id = ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(ticketId, limit);
  return rows.map(rowToRun);
}

/** All non-terminal runs across all folders. Used by the runner's
 *  app-startup resume sweep (L2.T6). */
export function listActiveRuns(db: Database.Database): WorkflowRunRow[] {
  const placeholders = [...ACTIVE_RUN_STATUSES].map(() => '?').join(',');
  const rows = db
    .prepare<string[], RunRow>(
      `SELECT * FROM workflow_runs WHERE status IN (${placeholders})`,
    )
    .all(...ACTIVE_RUN_STATUSES);
  return rows.map(rowToRun);
}

export function countActiveRunsInFolder(
  db: Database.Database,
  folderId: string,
): number {
  const placeholders = [...ACTIVE_RUN_STATUSES].map(() => '?').join(',');
  const row = db
    .prepare<unknown[], { c: number }>(
      `SELECT COUNT(*) AS c FROM workflow_runs
        WHERE folder_id = ? AND status IN (${placeholders})`,
    )
    .get(folderId, ...ACTIVE_RUN_STATUSES);
  return row?.c ?? 0;
}

/** Latest run per ticket id across the input list. Mirrors
 *  `AgentQueueRepository.listLatestForTasks` so the kanban-card
 *  badge endpoint can union both engines without per-row joins.
 *  Returns the newest run by `started_at` for each ticket — if a
 *  ticket has no rows, it's simply absent from the result map. */
export function listLatestForTasks(
  db: Database.Database,
  taskIds: string[],
): Map<string, WorkflowRunRow> {
  if (taskIds.length === 0) return new Map();
  const ids = taskIds.slice(0, 500);
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare<string[], RunRow>(
      `SELECT wr.* FROM workflow_runs wr
        INNER JOIN (
          SELECT ticket_id, MAX(started_at) AS max_ts
            FROM workflow_runs
           WHERE ticket_id IN (${placeholders})
           GROUP BY ticket_id
        ) latest ON wr.ticket_id = latest.ticket_id
                AND wr.started_at = latest.max_ts`,
    )
    .all(...ids);
  const out = new Map<string, WorkflowRunRow>();
  for (const row of rows) {
    const parsed = rowToRun(row);
    out.set(parsed.ticketId, parsed);
  }
  return out;
}

/** Active (non-terminal) runs scoped to one folder. Used by the
 *  toggle-off killer and the in-flight summary endpoint to surface
 *  workflow-runner runs alongside any legacy `mo_agent_queue` rows. */
export function listActiveRunsInFolder(
  db: Database.Database,
  folderId: string,
): WorkflowRunRow[] {
  const placeholders = [...ACTIVE_RUN_STATUSES].map(() => '?').join(',');
  const rows = db
    .prepare<unknown[], RunRow>(
      `SELECT * FROM workflow_runs
        WHERE folder_id = ? AND status IN (${placeholders})
        ORDER BY started_at ASC`,
    )
    .all(folderId, ...ACTIVE_RUN_STATUSES);
  return rows.map(rowToRun);
}

/** Phase 5 — read every run currently paused for human input. The
 *  startup-recovery sweep uses this to refuse to claim orphan paused
 *  rows back into `running` without a fresh user reply. */
export function listPausedRuns(db: Database.Database): WorkflowRunRow[] {
  const rows = db
    .prepare<[], RunRow>(
      `SELECT * FROM workflow_runs WHERE status = 'paused_ask_user'`,
    )
    .all();
  return rows.map(rowToRun);
}

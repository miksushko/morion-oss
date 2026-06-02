/**
 * WorkflowSchedulesRepository — CRUD + cron-due query for the
 * `workflow_schedules` table.
 *
 * Phase 1 of the Scheduler epic (ticket 01KSX1WJF0TR6949TDQS7Z1TXS).
 * Pure DB layer — no scheduler tick, no WorkflowRunner integration.
 *
 * Persistence shape (see migration 0040_workflow_schedules.sql):
 *   id, folder_id, workflow_id, cron_expr, enabled, last_run_at,
 *   last_run_status, created_at, updated_at.
 *
 * `listDue(now)` is the load-bearing query — it returns every enabled
 * schedule whose parsed cron matches `now` (minute resolution) AND
 * which wasn't already fired this same minute (double-fire guard).
 * SQLite can't evaluate cron strings; we pull all enabled rows and
 * filter via the JS cron parser. The folder-enabled index keeps the
 * fetch cheap (one row per active schedule, not a full scan).
 */
import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { matchesCron, parseCron, type CronExpr } from './cron.js';

export type ScheduleLastRunStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped';

export interface WorkflowSchedule {
  id: string;
  folderId: string;
  workflowId: string | null;
  cronExpr: string;
  enabled: boolean;
  lastRunAt: number | null;
  lastRunStatus: ScheduleLastRunStatus | null;
  createdAt: number;
  updatedAt: number;
}

interface ScheduleRow {
  id: string;
  folder_id: string;
  workflow_id: string | null;
  cron_expr: string;
  enabled: number;
  last_run_at: number | null;
  last_run_status: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateScheduleInput {
  folderId: string;
  workflowId?: string | null;
  cronExpr: string;
  enabled?: boolean;
  now?: number;
}

export interface UpdateScheduleInput {
  workflowId?: string | null;
  cronExpr?: string;
  enabled?: boolean;
  now?: number;
}

/**
 * Truncate epoch-ms to the start of its minute. Used so the
 * "already-fired this minute" guard in `listDue` doesn't accidentally
 * double-fire when two ticks fall on either side of a second boundary
 * within the same minute.
 */
function minuteStart(epochMs: number): number {
  return Math.floor(epochMs / 60_000) * 60_000;
}

export class WorkflowSchedulesRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Create a new schedule. `cronExpr` is validated up-front — invalid
   * expressions throw before any row is written. `enabled` defaults to
   * true, `workflowId` defaults to null (v1 hardcoded-autocode runs
   * use a null workflow_id, same as `workflow_runs`).
   */
  create(input: CreateScheduleInput): WorkflowSchedule {
    // Validate cron syntax before INSERT — fail fast, no orphan rows.
    parseCron(input.cronExpr);
    const now = input.now ?? Date.now();
    const id = ulid();
    const enabled = input.enabled === false ? 0 : 1;
    const workflowId = input.workflowId ?? null;
    this.db
      .prepare(
        `INSERT INTO workflow_schedules
          (id, folder_id, workflow_id, cron_expr, enabled, last_run_at,
           last_run_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, input.folderId, workflowId, input.cronExpr, enabled, now, now);
    return this.getById(id)!;
  }

  getById(id: string): WorkflowSchedule | null {
    const row = this.db
      .prepare<[string], ScheduleRow>('SELECT * FROM workflow_schedules WHERE id = ?')
      .get(id);
    return row ? this.rowTo(row) : null;
  }

  listByFolder(folderId: string): WorkflowSchedule[] {
    return this.db
      .prepare<[string], ScheduleRow>(
        'SELECT * FROM workflow_schedules WHERE folder_id = ? ORDER BY created_at',
      )
      .all(folderId)
      .map((r) => this.rowTo(r));
  }

  /**
   * Every enabled schedule across the workspace, ordered by id for
   * stable iteration. Used by the scheduler tick's listDue() — the
   * tick pulls this once per poll, then JS-filters by cron match.
   */
  listEnabled(): WorkflowSchedule[] {
    return this.db
      .prepare<[], ScheduleRow>(
        'SELECT * FROM workflow_schedules WHERE enabled = 1 ORDER BY id',
      )
      .all()
      .map((r) => this.rowTo(r));
  }

  /**
   * Schedules whose cron matches `now` (local-time, minute resolution)
   * and which weren't already fired in the same minute. The tick calls
   * this every poll and dispatches each returned schedule once.
   *
   * Double-fire guard: a schedule is excluded if its `last_run_at`
   * falls within the same minute as `now`. This means a 30-second
   * poll cadence (the default ConciergeScheduler interval) will only
   * fire each per-minute schedule once even though the cron matches
   * for the full 60s window.
   */
  listDue(now: Date): WorkflowSchedule[] {
    const nowMs = now.getTime();
    const nowMinute = minuteStart(nowMs);
    const enabled = this.listEnabled();
    const due: WorkflowSchedule[] = [];
    for (const s of enabled) {
      let cron: CronExpr;
      try {
        cron = parseCron(s.cronExpr);
      } catch {
        // Corrupt expression — silently skip. The repository can't log;
        // the tick's caller will surface the parse failure at the next
        // edit attempt (validation happens at create + update).
        continue;
      }
      if (!matchesCron(cron, now)) continue;
      if (s.lastRunAt !== null && minuteStart(s.lastRunAt) >= nowMinute) {
        continue; // already fired this minute
      }
      due.push(s);
    }
    return due;
  }

  /**
   * Update mutable fields. `cronExpr` is re-validated if present. Any
   * combination of fields can be patched; absent fields stay the same.
   * Returns the updated row, or null if id doesn't exist.
   */
  update(id: string, patch: UpdateScheduleInput): WorkflowSchedule | null {
    const existing = this.getById(id);
    if (!existing) return null;

    if (patch.cronExpr !== undefined) {
      parseCron(patch.cronExpr); // throws on invalid before any UPDATE
    }
    const now = patch.now ?? Date.now();
    const next = {
      workflowId: patch.workflowId !== undefined ? patch.workflowId : existing.workflowId,
      cronExpr: patch.cronExpr ?? existing.cronExpr,
      enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled ? 1 : 0,
    };
    this.db
      .prepare(
        `UPDATE workflow_schedules
            SET workflow_id = ?, cron_expr = ?, enabled = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(next.workflowId, next.cronExpr, next.enabled, now, id);
    return this.getById(id);
  }

  /**
   * Stamp a fire event. Updates `last_run_at` to `firedAt` (epoch-ms)
   * and `last_run_status` to the given status. Does NOT bump
   * `updated_at` — fire bookkeeping is metadata, not content.
   * Returns true if the row was updated (false = id not found).
   */
  markFired(id: string, status: ScheduleLastRunStatus, firedAt: number): boolean {
    const result = this.db
      .prepare(
        'UPDATE workflow_schedules SET last_run_at = ?, last_run_status = ? WHERE id = ?',
      )
      .run(firedAt, status, id);
    return result.changes > 0;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM workflow_schedules WHERE id = ?').run(id);
    return result.changes > 0;
  }

  private rowTo(row: ScheduleRow): WorkflowSchedule {
    return {
      id: row.id,
      folderId: row.folder_id,
      workflowId: row.workflow_id,
      cronExpr: row.cron_expr,
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status as ScheduleLastRunStatus | null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

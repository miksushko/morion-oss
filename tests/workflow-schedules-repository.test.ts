/**
 * Pins the WorkflowSchedulesRepository CRUD + listDue() contract.
 *
 * Phase 1 of the Scheduler epic (ticket 01KSX1WJF0TR6949TDQS7Z1TXS).
 * Repository-level tests only — no scheduler tick, no WorkflowRunner.
 * Cron syntax is covered separately by `cron-parser.test.ts`; here we
 * cover the cron+last_run_at interaction that governs double-fire
 * prevention.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import {
  WorkflowSchedulesRepository,
  type WorkflowSchedule,
} from '../src/core/auto-code/schedules/repository.js';

describe('WorkflowSchedulesRepository (01KSX1WJF0TR6949TDQS7Z1TXS)', () => {
  let handle: DbHandle;
  let db: Database.Database;
  let folders: FoldersRepository;
  let schedules: WorkflowSchedulesRepository;
  let folderId: string;

  beforeEach(() => {
    handle = openDb({ path: ':memory:' });
    db = handle.db;
    folders = new FoldersRepository(db);
    schedules = new WorkflowSchedulesRepository(db);
    folderId = folders.create('SchedulerTestFolder').id;
  });

  afterEach(() => {
    db.close();
  });

  describe('create', () => {
    it('persists a row with defaults (enabled=true, workflowId=null)', () => {
      const s = schedules.create({ folderId, cronExpr: '0 9 * * 1-5', now: 1_000 });
      expect(s.folderId).toBe(folderId);
      expect(s.cronExpr).toBe('0 9 * * 1-5');
      expect(s.enabled).toBe(true);
      expect(s.workflowId).toBeNull();
      expect(s.lastRunAt).toBeNull();
      expect(s.lastRunStatus).toBeNull();
      expect(s.createdAt).toBe(1_000);
      expect(s.updatedAt).toBe(1_000);
    });

    it('honours enabled=false', () => {
      const s = schedules.create({ folderId, cronExpr: '* * * * *', enabled: false });
      expect(s.enabled).toBe(false);
    });

    it('honours an explicit workflowId', () => {
      const s = schedules.create({
        folderId,
        workflowId: 'workflow_abc',
        cronExpr: '* * * * *',
      });
      expect(s.workflowId).toBe('workflow_abc');
    });

    it('throws on invalid cron before writing the row', () => {
      expect(() =>
        schedules.create({ folderId, cronExpr: 'not a cron' }),
      ).toThrow();
      // Confirm no row leaked into the table.
      const count = db
        .prepare('SELECT COUNT(*) as c FROM workflow_schedules')
        .get() as { c: number };
      expect(count.c).toBe(0);
    });
  });

  describe('getById / listByFolder', () => {
    it('round-trips a row by id', () => {
      const created = schedules.create({ folderId, cronExpr: '*/15 * * * *' });
      const fetched = schedules.getById(created.id);
      expect(fetched).toEqual(created);
    });

    it('returns null for unknown id', () => {
      expect(schedules.getById('does_not_exist')).toBeNull();
    });

    it('lists rows under a folder, ordered by created_at', () => {
      const a = schedules.create({ folderId, cronExpr: '* * * * *', now: 100 });
      const b = schedules.create({ folderId, cronExpr: '0 9 * * *', now: 200 });
      const otherFolder = folders.create('OtherFolder').id;
      schedules.create({ folderId: otherFolder, cronExpr: '* * * * *' });

      const list = schedules.listByFolder(folderId);
      expect(list.map((s: WorkflowSchedule) => s.id)).toEqual([a.id, b.id]);
    });
  });

  describe('update', () => {
    it('patches cronExpr + bumps updated_at', () => {
      const created = schedules.create({ folderId, cronExpr: '* * * * *', now: 1_000 });
      const updated = schedules.update(created.id, { cronExpr: '0 9 * * 1-5', now: 2_000 });
      expect(updated?.cronExpr).toBe('0 9 * * 1-5');
      expect(updated?.updatedAt).toBe(2_000);
      expect(updated?.createdAt).toBe(1_000); // unchanged
    });

    it('patches enabled toggle without losing other fields', () => {
      const created = schedules.create({
        folderId,
        cronExpr: '0 9 * * *',
        workflowId: 'wf_x',
      });
      const updated = schedules.update(created.id, { enabled: false });
      expect(updated?.enabled).toBe(false);
      expect(updated?.cronExpr).toBe('0 9 * * *');
      expect(updated?.workflowId).toBe('wf_x');
    });

    it('rejects invalid cron BEFORE writing (atomic)', () => {
      const created = schedules.create({ folderId, cronExpr: '* * * * *' });
      expect(() => schedules.update(created.id, { cronExpr: 'bogus' })).toThrow();
      // Original row untouched.
      expect(schedules.getById(created.id)?.cronExpr).toBe('* * * * *');
    });

    it('returns null for unknown id', () => {
      expect(schedules.update('missing', { enabled: false })).toBeNull();
    });
  });

  describe('markFired', () => {
    it('stamps last_run_at + last_run_status, does NOT bump updated_at', () => {
      const created = schedules.create({ folderId, cronExpr: '* * * * *', now: 1_000 });
      schedules.markFired(created.id, 'done', 5_000);
      const fetched = schedules.getById(created.id)!;
      expect(fetched.lastRunAt).toBe(5_000);
      expect(fetched.lastRunStatus).toBe('done');
      // updated_at is content-only — fire bookkeeping must not bump it,
      // or every tick would dirty the row and trigger downstream
      // change-detectors. Same convention as kanban-move on notes.
      expect(fetched.updatedAt).toBe(1_000);
    });

    it('returns false for unknown id', () => {
      expect(schedules.markFired('missing', 'done', 1)).toBe(false);
    });
  });

  describe('delete', () => {
    it('removes the row', () => {
      const created = schedules.create({ folderId, cronExpr: '* * * * *' });
      expect(schedules.delete(created.id)).toBe(true);
      expect(schedules.getById(created.id)).toBeNull();
    });

    it('cascades on folder deletion', () => {
      const created = schedules.create({ folderId, cronExpr: '* * * * *' });
      folders.delete(folderId);
      expect(schedules.getById(created.id)).toBeNull();
    });
  });

  describe('listEnabled', () => {
    it('excludes disabled schedules', () => {
      const a = schedules.create({ folderId, cronExpr: '* * * * *', enabled: true });
      schedules.create({ folderId, cronExpr: '* * * * *', enabled: false });
      const list = schedules.listEnabled();
      expect(list.map((s) => s.id)).toEqual([a.id]);
    });
  });

  describe('listDue', () => {
    // 2026-05-28 14:30 (Thursday) — used as the reference "now".
    const NOW = new Date(2026, 4, 28, 14, 30, 0, 0);

    it('returns enabled schedules whose cron matches the current minute', () => {
      const everyMinute = schedules.create({ folderId, cronExpr: '* * * * *' });
      schedules.create({ folderId, cronExpr: '0 9 * * *' }); // not due at 14:30
      const due = schedules.listDue(NOW);
      expect(due.map((s) => s.id)).toEqual([everyMinute.id]);
    });

    it('skips disabled schedules even when cron matches', () => {
      schedules.create({ folderId, cronExpr: '* * * * *', enabled: false });
      expect(schedules.listDue(NOW)).toEqual([]);
    });

    it('skips schedules already fired in the same minute', () => {
      const s = schedules.create({ folderId, cronExpr: '* * * * *' });
      // last_run_at within the same minute as NOW (NOW is 14:30:00 —
      // any 14:30:NN counts as "this minute").
      schedules.markFired(s.id, 'done', NOW.getTime() + 5_000);
      expect(schedules.listDue(NOW)).toEqual([]);
    });

    it('re-fires schedules whose last_run_at is in a previous minute', () => {
      const s = schedules.create({ folderId, cronExpr: '* * * * *' });
      const previousMinute = new Date(2026, 4, 28, 14, 29, 0, 0).getTime();
      schedules.markFired(s.id, 'done', previousMinute);
      const due = schedules.listDue(NOW);
      expect(due.map((d) => d.id)).toEqual([s.id]);
    });

    it('silently skips rows with corrupt cron_expr (defence-in-depth)', () => {
      // Should never happen — create/update validate — but if a row
      // somehow lands with bad cron (manual SQL edit, downgraded
      // schema, etc.), listDue must not throw the whole tick.
      const good = schedules.create({ folderId, cronExpr: '* * * * *' });
      db.prepare(
        `INSERT INTO workflow_schedules
           (id, folder_id, cron_expr, enabled, created_at, updated_at)
         VALUES ('bad', ?, 'garbage', 1, 0, 0)`,
      ).run(folderId);
      const due = schedules.listDue(NOW);
      expect(due.map((s) => s.id)).toEqual([good.id]);
    });
  });
});

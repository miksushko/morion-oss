/**
 * Pins the scheduler-tick → repository contract for Phase 1c.
 *
 * Ticket 01KSX1WJF0TR6949TDQS7Z1TXS. Unit-level — uses a real
 * WorkflowSchedulesRepository over a :memory: DB and a stub dispatch
 * function. Phase 1d will plug in the WorkflowRunner; this test
 * suite stays unchanged (the tick's contract with the repo doesn't
 * depend on what dispatch does internally, only that dispatch is
 * called once per due schedule and its outcome drives the status
 * stamp).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import {
  WorkflowSchedulesRepository,
  type WorkflowSchedule,
} from '../src/core/auto-code/schedules/repository.js';
import { buildWorkflowSchedulesTick } from '../src/core/auto-code/schedules/tick.js';

const NOW = new Date(2026, 4, 28, 14, 30, 0, 0); // Thu 14:30 local

describe('buildWorkflowSchedulesTick (01KSX1WJF0TR6949TDQS7Z1TXS)', () => {
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
    folderId = folders.create('TickTestFolder').id;
  });

  afterEach(() => {
    db.close();
  });

  it('returns a no-op summary when no schedules are due', async () => {
    schedules.create({ folderId, cronExpr: '0 9 * * *' }); // not due at 14:30
    const dispatch = vi.fn(async () => {});
    const tick = buildWorkflowSchedulesTick({
      repo: schedules,
      dispatch,
      now: () => NOW,
    });
    const summary = await tick();
    expect(summary).toEqual({ dueCount: 0, fired: 0, failed: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches each due schedule exactly once + stamps last_run_at', async () => {
    const a = schedules.create({ folderId, cronExpr: '* * * * *' });
    const b = schedules.create({ folderId, cronExpr: '*/15 * * * *' }); // 14:30 matches
    const dispatch = vi.fn(async () => {});
    const tick = buildWorkflowSchedulesTick({
      repo: schedules,
      dispatch,
      now: () => NOW,
    });

    const summary = await tick();
    expect(summary).toEqual({ dueCount: 2, fired: 2, failed: 0 });
    expect(dispatch).toHaveBeenCalledTimes(2);
    const dispatchedIds = dispatch.mock.calls.map(
      (c) => (c[0] as WorkflowSchedule).id,
    );
    expect(dispatchedIds.sort()).toEqual([a.id, b.id].sort());

    // Both schedules now have last_run_at + last_run_status='pending'.
    const aFresh = schedules.getById(a.id)!;
    const bFresh = schedules.getById(b.id)!;
    expect(aFresh.lastRunAt).toBe(NOW.getTime());
    expect(aFresh.lastRunStatus).toBe('pending');
    expect(bFresh.lastRunAt).toBe(NOW.getTime());
    expect(bFresh.lastRunStatus).toBe('pending');
  });

  it("marks schedule 'failed' when dispatch rejects, continues with the rest", async () => {
    const ok = schedules.create({ folderId, cronExpr: '* * * * *' });
    const bad = schedules.create({ folderId, cronExpr: '* * * * *' });
    const dispatch = vi.fn(async (s: WorkflowSchedule) => {
      if (s.id === bad.id) throw new Error('dispatch boom');
    });
    const tick = buildWorkflowSchedulesTick({
      repo: schedules,
      dispatch,
      now: () => NOW,
      log: { info: () => {}, warn: () => {} },
    });

    const summary = await tick();
    expect(summary).toEqual({ dueCount: 2, fired: 1, failed: 1 });

    expect(schedules.getById(ok.id)!.lastRunStatus).toBe('pending');
    expect(schedules.getById(bad.id)!.lastRunStatus).toBe('failed');
    // Both stamped with the same firedAt timestamp — the "this tick
    // tried both" invariant — so listDue's same-minute guard skips
    // both on the next poll.
    expect(schedules.getById(ok.id)!.lastRunAt).toBe(NOW.getTime());
    expect(schedules.getById(bad.id)!.lastRunAt).toBe(NOW.getTime());
  });

  it('does not re-fire a schedule on a second tick within the same minute', async () => {
    schedules.create({ folderId, cronExpr: '* * * * *' });
    const dispatch = vi.fn(async () => {});
    const tick = buildWorkflowSchedulesTick({
      repo: schedules,
      dispatch,
      now: () => NOW,
    });

    await tick();
    await tick();
    // Second tick sees last_run_at within the same minute and skips.
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does re-fire on the next minute', async () => {
    schedules.create({ folderId, cronExpr: '* * * * *' });
    const dispatch = vi.fn(async () => {});
    const nextMinute = new Date(NOW.getTime() + 60_000);

    let nowOverride = NOW;
    const tick = buildWorkflowSchedulesTick({
      repo: schedules,
      dispatch,
      now: () => nowOverride,
    });
    await tick();
    nowOverride = nextMinute;
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('logs once per non-empty tick', async () => {
    schedules.create({ folderId, cronExpr: '* * * * *' });
    const info = vi.fn();
    const warn = vi.fn();
    const dispatch = vi.fn(async () => {});
    const tick = buildWorkflowSchedulesTick({
      repo: schedules,
      dispatch,
      now: () => NOW,
      log: { info, warn },
    });
    await tick();
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

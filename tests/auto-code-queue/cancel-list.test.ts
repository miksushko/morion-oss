import { describe, it, expect, beforeEach } from 'vitest';
import { makeTask, setup, type Ctx } from '../helpers/auto-code-queue-setup.js';

describe('AgentQueueRepository — cancel + listInFlight', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('cancelAllInFlightForFolder transitions every non-terminal row + returns them', () => {
    const folder = ctx.folders.create('F');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const taskId = makeTask(ctx, folder.id, `# T${i}`);
      const r = ctx.queue.enqueue({
        folderId: folder.id,
        taskId,
        repoPath: ctx.fakeRepo,
        now: i,
      });
      if (r.kind !== 'inserted') throw new Error('seed');
      ids.push(r.row.id);
    }
    // Drive a couple through different states.
    ctx.queue.claimNext(folder.id);
    ctx.queue.claimNext(folder.id);
    const cancelled = ctx.queue.cancelAllInFlightForFolder(folder.id, 'toggle-off');
    expect(cancelled).toHaveLength(3);
    expect(cancelled.every((r) => r.state === 'cancelled')).toBe(true);
    expect(cancelled.every((r) => r.lastError === 'toggle-off')).toBe(true);
    expect(cancelled.every((r) => r.activePid === null)).toBe(true);
    expect(cancelled.every((r) => r.claimedAt === null)).toBe(true);
    // No more in-flight rows — listInFlightForFolder returns empty.
    expect(ctx.queue.listInFlightForFolder(folder.id)).toHaveLength(0);
  });

  it('cancelAllInFlightForFolder leaves terminal history intact', () => {
    const folder = ctx.folders.create('F');
    const t1 = makeTask(ctx, folder.id, '# T1');
    const t2 = makeTask(ctx, folder.id, '# T2');
    const r1 = ctx.queue.enqueue({ folderId: folder.id, taskId: t1, repoPath: ctx.fakeRepo });
    const r2 = ctx.queue.enqueue({ folderId: folder.id, taskId: t2, repoPath: ctx.fakeRepo });
    if (r1.kind !== 'inserted' || r2.kind !== 'inserted') throw new Error('seed');
    ctx.queue.claimNext(folder.id);
    ctx.queue.transition(r1.row.id, 'fix_running', 'done', { lastVerdict: 'approve' });
    const cancelled = ctx.queue.cancelAllInFlightForFolder(folder.id);
    expect(cancelled.map((r) => r.id)).toEqual([r2.row.id]);
    expect(ctx.queue.getById(r1.row.id)?.state).toBe('done');
    expect(ctx.queue.getById(r2.row.id)?.state).toBe('cancelled');
  });

  it('cancel is per-folder — neighbour rows untouched', () => {
    const a = ctx.folders.create('A');
    const b = ctx.folders.create('B');
    const ta = makeTask(ctx, a.id);
    const tb = makeTask(ctx, b.id);
    const ra = ctx.queue.enqueue({ folderId: a.id, taskId: ta, repoPath: ctx.fakeRepo });
    const rb = ctx.queue.enqueue({ folderId: b.id, taskId: tb, repoPath: ctx.fakeRepo });
    if (ra.kind !== 'inserted' || rb.kind !== 'inserted') throw new Error('seed');
    ctx.queue.cancelAllInFlightForFolder(a.id);
    expect(ctx.queue.getById(ra.row.id)?.state).toBe('cancelled');
    expect(ctx.queue.getById(rb.row.id)?.state).toBe('pending');
  });
});

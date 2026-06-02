import { describe, it, expect, beforeEach } from 'vitest';
import {
  AgentQueueRepository,
  MAX_INFLIGHT_PER_FOLDER,
} from '../../src/core/auto-code/queue.js';
import { makeTask, setup, type Ctx } from '../helpers/auto-code-queue-setup.js';

describe('AgentQueueRepository — claim + concurrency cap', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('claimNext picks oldest pending and transitions to fix_running with claimed_at + attempts++', () => {
    const folder = ctx.folders.create('F');
    const t1 = makeTask(ctx, folder.id, '# T1');
    const t2 = makeTask(ctx, folder.id, '# T2');
    ctx.queue.enqueue({ folderId: folder.id, taskId: t1, repoPath: ctx.fakeRepo, now: 100 });
    ctx.queue.enqueue({ folderId: folder.id, taskId: t2, repoPath: ctx.fakeRepo, now: 200 });
    const claimed = ctx.queue.claimNext(folder.id, 5_000);
    expect(claimed).not.toBeNull();
    if (!claimed) return;
    expect(claimed.taskId).toBe(t1);
    expect(claimed.state).toBe('fix_running');
    expect(claimed.attempts).toBe(1);
    expect(claimed.claimedAt).toBe(5_000);
  });

  it('claimNext returns null when no pending rows remain', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    const first = ctx.queue.claimNext(folder.id);
    expect(first).not.toBeNull();
    const second = ctx.queue.claimNext(folder.id);
    expect(second).toBeNull();
  });

  it('claimNext respects MAX_INFLIGHT_PER_FOLDER (5) — the (cap+1)th pending row waits', () => {
    const folder = ctx.folders.create('F');
    const ids: string[] = [];
    for (let i = 0; i < MAX_INFLIGHT_PER_FOLDER + 1; i++) {
      ids.push(makeTask(ctx, folder.id, `# T${i}`));
      ctx.queue.enqueue({ folderId: folder.id, taskId: ids[i]!, repoPath: ctx.fakeRepo, now: i });
    }
    // Drain the cap.
    const claims: Array<ReturnType<AgentQueueRepository['claimNext']>> = [];
    for (let i = 0; i < MAX_INFLIGHT_PER_FOLDER; i++) {
      claims.push(ctx.queue.claimNext(folder.id));
    }
    expect(claims.every(Boolean)).toBe(true);
    // (cap+1)th claim must refuse — running count == cap.
    expect(ctx.queue.claimNext(folder.id)).toBeNull();
    // Finishing one frees the slot — next claim picks the only
    // remaining pending row (the (cap+1)th enqueued, FIFO).
    ctx.queue.transition(claims[0]!.id, 'fix_running', 'done', { lastVerdict: 'approve' });
    const slotted = ctx.queue.claimNext(folder.id);
    expect(slotted).not.toBeNull();
    expect(slotted?.taskId).toBe(ids[MAX_INFLIGHT_PER_FOLDER]);
  });

  it('cap is per-folder — neighbouring folders are independent', () => {
    const a = ctx.folders.create('A');
    const b = ctx.folders.create('B');
    for (let i = 0; i < MAX_INFLIGHT_PER_FOLDER; i++) {
      const ta = makeTask(ctx, a.id, `# A${i}`);
      const tb = makeTask(ctx, b.id, `# B${i}`);
      ctx.queue.enqueue({ folderId: a.id, taskId: ta, repoPath: ctx.fakeRepo });
      ctx.queue.enqueue({ folderId: b.id, taskId: tb, repoPath: ctx.fakeRepo });
    }
    for (let i = 0; i < MAX_INFLIGHT_PER_FOLDER; i++) {
      ctx.queue.claimNext(a.id);
    }
    // A is full — but B starts empty of running rows.
    expect(ctx.queue.claimNext(a.id)).toBeNull();
    expect(ctx.queue.claimNext(b.id)).not.toBeNull();
  });

  it('inFlightCount counts pending + running + reopened, excludes terminal', () => {
    const folder = ctx.folders.create('F');
    const t1 = makeTask(ctx, folder.id, '# T1');
    const t2 = makeTask(ctx, folder.id, '# T2');
    const t3 = makeTask(ctx, folder.id, '# T3');
    const r1 = ctx.queue.enqueue({ folderId: folder.id, taskId: t1, repoPath: ctx.fakeRepo });
    const r2 = ctx.queue.enqueue({ folderId: folder.id, taskId: t2, repoPath: ctx.fakeRepo });
    const r3 = ctx.queue.enqueue({ folderId: folder.id, taskId: t3, repoPath: ctx.fakeRepo });
    if (r1.kind !== 'inserted' || r2.kind !== 'inserted' || r3.kind !== 'inserted') throw new Error('seed');
    expect(ctx.queue.inFlightCount(folder.id)).toBe(3);
    ctx.queue.transition(r1.row.id, 'pending', 'cancelled');
    expect(ctx.queue.inFlightCount(folder.id)).toBe(2);
    // Move r2 through a reopen — still in flight.
    ctx.queue.claimNext(folder.id); // claims r2 (oldest pending after r1 cancelled)
    ctx.queue.transition(r2.row.id, 'fix_running', 'fix_review');
    ctx.queue.transition(r2.row.id, 'fix_review', 'review_running');
    ctx.queue.transition(r2.row.id, 'review_running', 'reopened', {
      reopenCount: 1,
      lastVerdict: 'reopen',
    });
    expect(ctx.queue.inFlightCount(folder.id)).toBe(2);
    // Reference r3 so the unused-var lint stays happy + documents the seed.
    expect(ctx.queue.getById(r3.row.id)?.state).toBe('pending');
  });
});

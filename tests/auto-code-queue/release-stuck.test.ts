import { describe, it, expect, beforeEach } from 'vitest';
import { MAX_ATTEMPTS_BEFORE_FAILED } from '../../src/core/auto-code/queue.js';
import { makeTask, setup, type Ctx } from '../helpers/auto-code-queue-setup.js';

describe('AgentQueueRepository — releaseStuck', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('releases stuck fix_running back to pending + bumps attempts', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const r = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    if (r.kind !== 'inserted') throw new Error('seed');
    // Claim at t=1000, mark as if a worker died with active_pid set.
    ctx.queue.claimNext(folder.id, 1_000);
    ctx.queue.setActivePid(r.row.id, 4321);
    // Release-stuck at t=2000 with a 500ms threshold → row qualifies.
    const summary = ctx.queue.releaseStuck(500, 2_000);
    expect(summary.released).toBe(1);
    expect(summary.failed).toBe(0);
    const after = ctx.queue.getById(r.row.id);
    expect(after?.state).toBe('pending');
    expect(after?.attempts).toBe(2); // 1 from claim, +1 from release
    expect(after?.activePid).toBeNull();
    expect(after?.claimedAt).toBeNull();
    expect(after?.lastError).toBe('stuck');
  });

  it('releases stuck review_running back to fix_review', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const r = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    if (r.kind !== 'inserted') throw new Error('seed');
    ctx.queue.claimNext(folder.id, 1_000);
    ctx.queue.transition(r.row.id, 'fix_running', 'fix_review');
    // Mark review running with a stale claimed_at (cheat by transition + setActivePid).
    // For this test we transition to review_running and then artificially backdate
    // claimed_at via setActivePid + a follow-up UPDATE — but the easier path is
    // transition → review_running and use releaseStuck with a low threshold.
    ctx.queue.transition(r.row.id, 'fix_review', 'review_running');
    // Manually backdate claimed_at via the public claimNext-like path: there
    // isn't one for review, so we use raw SQL — same pattern the caller code
    // already establishes (claimed_at is owned by claim semantics + tests).
    ctx.handle.db
      .prepare(`UPDATE mo_agent_queue SET claimed_at = ? WHERE id = ?`)
      .run(1_500, r.row.id);
    const summary = ctx.queue.releaseStuck(100, 5_000);
    expect(summary.released).toBe(1);
    const after = ctx.queue.getById(r.row.id);
    expect(after?.state).toBe('fix_review');
  });

  it('escalates to failed once attempts cross the cap', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const r = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    if (r.kind !== 'inserted') throw new Error('seed');
    // Manually bump attempts to one below the cap so the next stale
    // recovery pass tips over into 'failed'.
    ctx.handle.db
      .prepare(`UPDATE mo_agent_queue SET attempts = ? WHERE id = ?`)
      .run(MAX_ATTEMPTS_BEFORE_FAILED - 1, r.row.id);
    ctx.queue.claimNext(folder.id, 1_000); // attempts becomes MAX (was MAX-1, +1 in claim)
    const summary = ctx.queue.releaseStuck(500, 2_000);
    expect(summary.failed).toBe(1);
    expect(summary.released).toBe(0);
    const after = ctx.queue.getById(r.row.id);
    expect(after?.state).toBe('failed');
    expect(after?.activePid).toBeNull();
    expect(after?.claimedAt).toBeNull();
  });

  it('leaves recently-claimed rows alone', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const r = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    if (r.kind !== 'inserted') throw new Error('seed');
    ctx.queue.claimNext(folder.id, 9_000);
    // 100ms later, with a 5min threshold → no-op.
    const summary = ctx.queue.releaseStuck(5 * 60 * 1000, 9_100);
    expect(summary.released).toBe(0);
    expect(summary.failed).toBe(0);
    expect(ctx.queue.getById(r.row.id)?.state).toBe('fix_running');
  });
});

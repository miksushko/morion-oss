import { describe, it, expect, beforeEach } from 'vitest';
import {
  IN_FLIGHT_STATES,
  RUNNING_STATES,
  TERMINAL_STATES,
} from '../../src/core/auto-code/queue.js';
import { makeTask, setup, type Ctx } from '../helpers/auto-code-queue-setup.js';

describe('AgentQueueRepository — transitions', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('transition fires only when the source state matches (optimistic lock)', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const r = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    if (r.kind !== 'inserted') throw new Error('seed');
    // Wrong source state → no-op + null return.
    const bad = ctx.queue.transition(r.row.id, 'fix_running', 'done');
    expect(bad).toBeNull();
    expect(ctx.queue.getById(r.row.id)?.state).toBe('pending');
  });

  it('transition persists patch fields atomically with the state change', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const r = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    if (r.kind !== 'inserted') throw new Error('seed');
    ctx.queue.claimNext(folder.id);
    const moved = ctx.queue.transition(r.row.id, 'fix_running', 'fix_review', {
      worktreeName: `auto-${r.row.id.toLowerCase()}`,
      fixSessionId: 'sess-fix-uuid',
      activePid: 12345,
    });
    expect(moved).not.toBeNull();
    if (!moved) return;
    expect(moved.state).toBe('fix_review');
    expect(moved.worktreeName).toBe(`auto-${r.row.id.toLowerCase()}`);
    expect(moved.fixSessionId).toBe('sess-fix-uuid');
    expect(moved.activePid).toBe(12345);
  });

  it('terminal transitions clear claimed_at + active_pid even without explicit patch', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const r = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    if (r.kind !== 'inserted') throw new Error('seed');
    ctx.queue.claimNext(folder.id);
    ctx.queue.setActivePid(r.row.id, 4242);
    const done = ctx.queue.transition(r.row.id, 'fix_running', 'done', { lastVerdict: 'approve' });
    expect(done?.claimedAt).toBeNull();
    expect(done?.activePid).toBeNull();
    expect(done?.lastVerdict).toBe('approve');
  });

  it('reopen ladder: pending → … → reopened → fix_running, reopen_count++', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const r = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    if (r.kind !== 'inserted') throw new Error('seed');
    ctx.queue.claimNext(folder.id);
    ctx.queue.transition(r.row.id, 'fix_running', 'fix_review', { fixSessionId: 'sess-1' });
    ctx.queue.transition(r.row.id, 'fix_review', 'review_running');
    const reopened = ctx.queue.transition(r.row.id, 'review_running', 'reopened', {
      reopenCount: 1,
      lastVerdict: 'reopen',
    });
    expect(reopened?.reopenCount).toBe(1);
    expect(reopened?.fixSessionId).toBe('sess-1'); // preserved across the ladder
    // Resume — orchestrator's next tick: reopened → fix_running on the
    // SAME session id (no claimNext, since the row is already in flight).
    const resumed = ctx.queue.transition(r.row.id, 'reopened', 'fix_running');
    expect(resumed?.fixSessionId).toBe('sess-1');
  });

  it('setActivePid is a side-effect write, no state change required', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const r = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    if (r.kind !== 'inserted') throw new Error('seed');
    ctx.queue.claimNext(folder.id);
    ctx.queue.setActivePid(r.row.id, 9999);
    expect(ctx.queue.getById(r.row.id)?.activePid).toBe(9999);
    ctx.queue.setActivePid(r.row.id, null);
    expect(ctx.queue.getById(r.row.id)?.activePid).toBeNull();
  });
});

describe('AgentQueueRepository — invariant constants', () => {
  it('state constants are mutually consistent', () => {
    // Every running state is also in-flight.
    for (const s of RUNNING_STATES) {
      expect(IN_FLIGHT_STATES.has(s)).toBe(true);
    }
    // Terminal states never overlap with in-flight states.
    for (const s of TERMINAL_STATES) {
      expect(IN_FLIGHT_STATES.has(s)).toBe(false);
    }
  });
});

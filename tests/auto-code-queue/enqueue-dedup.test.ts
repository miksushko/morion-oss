import { describe, it, expect, beforeEach } from 'vitest';
import { makeTask, setup, type Ctx } from '../helpers/auto-code-queue-setup.js';

describe('AgentQueueRepository — enqueue + dedup', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('inserts a fresh pending row + roundtrips every column', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const result = ctx.queue.enqueue({
      folderId: folder.id,
      taskId,
      repoPath: ctx.fakeRepo,
      now: 1_000,
    });
    expect(result.kind).toBe('inserted');
    if (result.kind !== 'inserted') return;
    expect(result.row.state).toBe('pending');
    expect(result.row.attempts).toBe(0);
    expect(result.row.reopenCount).toBe(0);
    expect(result.row.repoPath).toBe(ctx.fakeRepo);
    expect(result.row.fixSessionId).toBeNull();
    expect(result.row.reviewSessionId).toBeNull();
    expect(result.row.activePid).toBeNull();
    expect(result.row.claimedAt).toBeNull();
    // session_group_id defaults to row id (Phase 5 will overwrite).
    expect(result.row.sessionGroupId).toBe(result.row.id);
    expect(result.row.createdAt).toBe(1_000);
    expect(result.row.updatedAt).toBe(1_000);
  });

  it('dedups a second enqueue while the first is still in flight', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const first = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    const second = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    expect(first.kind).toBe('inserted');
    expect(second.kind).toBe('deduped');
    if (first.kind !== 'inserted' || second.kind !== 'deduped') return;
    expect(second.existing.id).toBe(first.row.id);
  });

  it('lets the next enqueue succeed once the prior row is terminal', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const first = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    if (first.kind !== 'inserted') throw new Error('seed failed');
    // Drive it through a plausible happy path: pending → fix_running → done.
    ctx.queue.claimNext(folder.id);
    ctx.queue.transition(first.row.id, 'fix_running', 'done', { lastVerdict: 'approve' });
    const second = ctx.queue.enqueue({ folderId: folder.id, taskId, repoPath: ctx.fakeRepo });
    expect(second.kind).toBe('inserted');
    if (second.kind !== 'inserted') return;
    expect(second.row.id).not.toBe(first.row.id);
    // Both rows now coexist, the old one terminal.
    expect(ctx.queue.getById(first.row.id)?.state).toBe('done');
  });

  it('honors a caller-supplied sessionGroupId (Phase 5 share-session hook)', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const result = ctx.queue.enqueue({
      folderId: folder.id,
      taskId,
      repoPath: ctx.fakeRepo,
      sessionGroupId: 'shared-group-xyz',
    });
    if (result.kind !== 'inserted') throw new Error('insert failed');
    expect(result.row.sessionGroupId).toBe('shared-group-xyz');
  });
});

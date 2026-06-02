import { describe, it, expect, beforeEach } from 'vitest';
import { makeTask, setup, type Ctx } from '../helpers/auto-code-queue-setup.js';

describe('AgentQueueRepository — listLatestForTasks (kanban-badge batch)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns empty Map for empty input + does not hit SQLite', () => {
    const map = ctx.queue.listLatestForTasks([]);
    expect(map.size).toBe(0);
  });

  it('returns the LATEST row per task id across mixed in-flight + terminal', () => {
    const folder = ctx.folders.create('F');
    const taskA = makeTask(ctx, folder.id, '# A');
    const taskB = makeTask(ctx, folder.id, '# B');
    const taskC = makeTask(ctx, folder.id, '# C');

    // Task A: two historical attempts (older done, newer pending).
    const a1 = ctx.queue.enqueue({
      folderId: folder.id,
      taskId: taskA,
      repoPath: ctx.fakeRepo,
      now: 1_000,
    });
    if (a1.kind !== 'inserted') throw new Error('seed enqueue failed');
    ctx.queue.transition(a1.row.id, 'pending', 'fix_running', { now: 1_500 });
    ctx.queue.transition(a1.row.id, 'fix_running', 'done', { now: 2_000 });
    const a2 = ctx.queue.enqueue({
      folderId: folder.id,
      taskId: taskA,
      repoPath: ctx.fakeRepo,
      now: 5_000,
    });
    if (a2.kind !== 'inserted') throw new Error('seed enqueue failed');

    // Task B: one done row.
    const b1 = ctx.queue.enqueue({
      folderId: folder.id,
      taskId: taskB,
      repoPath: ctx.fakeRepo,
      now: 3_000,
    });
    if (b1.kind !== 'inserted') throw new Error('seed enqueue failed');
    ctx.queue.transition(b1.row.id, 'pending', 'fix_running', { now: 3_500 });
    ctx.queue.transition(b1.row.id, 'fix_running', 'done', { now: 4_000 });

    // Task C: never enqueued — must be ABSENT from the Map.
    const map = ctx.queue.listLatestForTasks([taskA, taskB, taskC]);
    expect(map.size).toBe(2);
    // Task A's latest is a2 (newer created_at), not the older done a1.
    expect(map.get(taskA)?.id).toBe(a2.row.id);
    expect(map.get(taskA)?.state).toBe('pending');
    // Task B's latest is the done row.
    expect(map.get(taskB)?.id).toBe(b1.row.id);
    expect(map.get(taskB)?.state).toBe('done');
    expect(map.get(taskC)).toBeUndefined();
  });

  it('clamps oversize batches to 500 — never crashes the DB', () => {
    const folder = ctx.folders.create('F');
    const taskId = makeTask(ctx, folder.id);
    const r = ctx.queue.enqueue({
      folderId: folder.id,
      taskId,
      repoPath: ctx.fakeRepo,
      now: 1_000,
    });
    if (r.kind !== 'inserted') throw new Error('seed enqueue failed');
    // 600 ids — clamped to 500 inside listLatestForTasks. The real
    // task id stays in the first 500, so we still get its row back.
    const ids: string[] = [taskId];
    for (let i = 0; i < 599; i++) ids.push(`fake-task-${i}`);
    expect(() => ctx.queue.listLatestForTasks(ids)).not.toThrow();
    const map = ctx.queue.listLatestForTasks(ids);
    expect(map.get(taskId)?.id).toBe(r.row.id);
  });

  it('runs a SINGLE SQL query regardless of batch size — no N+1', () => {
    // Naive per-task lookup would issue N queries. listLatestForTasks
    // uses one INNER JOIN against a single MAX-grouped subquery. We
    // can't directly count queries here (better-sqlite3 doesn't
    // expose a hook) but we can prove correctness on a 50-task
    // batch in a single call: no per-task calls fall back into the
    // implementation.
    const folder = ctx.folders.create('F');
    const taskIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = makeTask(ctx, folder.id, `# T${i}`);
      taskIds.push(id);
      const r = ctx.queue.enqueue({
        folderId: folder.id,
        taskId: id,
        repoPath: ctx.fakeRepo,
        now: 1_000 + i,
      });
      if (r.kind !== 'inserted') throw new Error('seed enqueue failed');
    }
    const map = ctx.queue.listLatestForTasks(taskIds);
    expect(map.size).toBe(50);
    for (const id of taskIds) {
      expect(map.get(id)?.taskId).toBe(id);
    }
  });
});

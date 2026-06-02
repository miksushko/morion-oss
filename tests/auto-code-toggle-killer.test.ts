import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { AgentQueueRepository } from '../src/core/auto-code/queue.js';
import {
  cancelInFlightForFolder,
  cancelInFlightForTask,
  inFlightSummary,
} from '../src/core/auto-code/toggle-killer.js';

/**
 * Auto-code Phase 2 — toggle-off killer
 * (sub-ticket 01KQEED9ARX0QZ25S775WDBQC1).
 *
 * Tests inject `killProcess` / `removeWorktreeImpl` / `isProcessAlive`
 * so we never signal real PIDs or touch the filesystem. The actual
 * SIGTERM-then-SIGKILL escalation is exercised via the alive-probe
 * stub: when it returns true after the grace window the killer
 * escalates; when it returns false it doesn't.
 */

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  queue: AgentQueueRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  return {
    handle,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
    queue: new AgentQueueRepository(handle.db),
  };
}

function seedRunningRow(
  ctx: Ctx,
  folderId: string,
  pid: number | null,
  worktreeName: string | null = 'auto-x',
): { taskId: string; rowId: string } {
  const task = ctx.notes.create({ body: '# T', folderId, source: 'user' }, 'user');
  const enq = ctx.queue.enqueue({
    folderId,
    taskId: task.id,
    repoPath: '/tmp/repo',
  });
  if (enq.kind !== 'inserted') throw new Error('seed enqueue failed');
  ctx.queue.claimNext(folderId);
  if (pid !== null) ctx.queue.setActivePid(enq.row.id, pid);
  if (worktreeName !== null) {
    ctx.queue.transition(enq.row.id, 'fix_running', 'fix_running', {
      worktreeName,
    });
  }
  return { taskId: task.id, rowId: enq.row.id };
}

// Track invocations across mocks so tests can assert SIGTERM/SIGKILL
// + worktree cleanup happened in the right order.
function makeStubs(opts: { stillAliveAfterTerm?: number[] } = {}) {
  const sigtermPids: number[] = [];
  const sigkillPids: number[] = [];
  const removedWorktrees: string[] = [];
  const removeWorktreeErrors: Record<string, string> = {};
  const alivePids = new Set<number>(opts.stillAliveAfterTerm ?? []);
  const stubs = {
    killProcess: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => {
      if (signal === 'SIGTERM') sigtermPids.push(pid);
      if (signal === 'SIGKILL') sigkillPids.push(pid);
      // After SIGKILL, the PID is no longer alive.
      if (signal === 'SIGKILL') alivePids.delete(pid);
    },
    isProcessAlive: (pid: number) => alivePids.has(pid),
    removeWorktreeImpl: async (_repoPath: string, name: string) => {
      removedWorktrees.push(name);
      const err = removeWorktreeErrors[name];
      if (err) {
        return { worktreeRemoved: false, branchRemoved: false, error: err };
      }
      return { worktreeRemoved: true, branchRemoved: true, error: null };
    },
    removeError: (name: string, err: string) => {
      removeWorktreeErrors[name] = err;
    },
  };
  return { stubs, sigtermPids, sigkillPids, removedWorktrees };
}

describe('inFlightSummary', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns count + task titles for in-flight rows', () => {
    const folder = ctx.folders.create('F');
    seedRunningRow(ctx, folder.id, 100);
    seedRunningRow(ctx, folder.id, 101);
    const result = inFlightSummary(ctx.queue, folder.id, (id) =>
      ctx.notes.getById(id),
    );
    expect(result.count).toBe(2);
    expect(result.taskTitles.length).toBe(2);
    // Default note title from `# T` body is 'T'.
    expect(result.taskTitles).toEqual(['T', 'T']);
  });

  it('returns count=0 when no rows are in flight', () => {
    const folder = ctx.folders.create('F');
    const result = inFlightSummary(ctx.queue, folder.id, (id) =>
      ctx.notes.getById(id),
    );
    expect(result.count).toBe(0);
    expect(result.taskTitles).toEqual([]);
  });

  it('falls back to taskId when the note lookup returns null', () => {
    const folder = ctx.folders.create('F');
    const seeded = seedRunningRow(ctx, folder.id, 100);
    // Lookup function returns null → row's taskId echoed.
    const result = inFlightSummary(ctx.queue, folder.id, () => null);
    expect(result.taskTitles).toEqual([seeded.taskId]);
  });
});

describe('cancelInFlightForFolder — happy path', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('cancels every in-flight row, SIGTERMs each PID, removes worktrees', async () => {
    const folder = ctx.folders.create('F');
    const r1 = seedRunningRow(ctx, folder.id, 1001, 'auto-1');
    const r2 = seedRunningRow(ctx, folder.id, 1002, 'auto-2');
    const r3 = seedRunningRow(ctx, folder.id, 1003, 'auto-3');
    const { stubs, sigtermPids, sigkillPids, removedWorktrees } = makeStubs();
    const summary = await cancelInFlightForFolder(folder.id, {
      queue: ctx.queue,
      repoPath: '/tmp/repo',
      killAfterTermMs: 50,
      ...stubs,
    });
    expect(summary.cancelledCount).toBe(3);
    expect(summary.signaledPids).toEqual([1001, 1002, 1003]);
    expect(summary.forceKilledPids).toEqual([]);
    expect(summary.worktreesRemoved).toBe(3);
    expect(sigtermPids).toEqual([1001, 1002, 1003]);
    expect(sigkillPids).toEqual([]);
    expect(removedWorktrees).toEqual(['auto-1', 'auto-2', 'auto-3']);
    // All rows now in terminal state.
    for (const id of [r1.rowId, r2.rowId, r3.rowId]) {
      expect(ctx.queue.getById(id)?.state).toBe('cancelled');
      expect(ctx.queue.getById(id)?.activePid).toBeNull();
    }
    // listInFlightForFolder is now empty.
    expect(ctx.queue.listInFlightForFolder(folder.id).length).toBe(0);
  });

  it('escalates to SIGKILL for PIDs still alive after the grace window', async () => {
    const folder = ctx.folders.create('F');
    seedRunningRow(ctx, folder.id, 2001, 'auto-1');
    seedRunningRow(ctx, folder.id, 2002, 'auto-2');
    // 2001 ignores SIGTERM and stays alive; 2002 dies cleanly.
    const { stubs, sigtermPids, sigkillPids } = makeStubs({
      stillAliveAfterTerm: [2001],
    });
    const summary = await cancelInFlightForFolder(folder.id, {
      queue: ctx.queue,
      repoPath: '/tmp/repo',
      killAfterTermMs: 50,
      ...stubs,
    });
    expect(sigtermPids).toEqual([2001, 2002]);
    expect(sigkillPids).toEqual([2001]);
    expect(summary.forceKilledPids).toEqual([2001]);
  });

  it('is a no-op on a folder with no in-flight rows', async () => {
    const folder = ctx.folders.create('F');
    const { stubs, sigtermPids, removedWorktrees } = makeStubs();
    const summary = await cancelInFlightForFolder(folder.id, {
      queue: ctx.queue,
      repoPath: '/tmp/repo',
      ...stubs,
    });
    expect(summary.cancelledCount).toBe(0);
    expect(sigtermPids).toEqual([]);
    expect(removedWorktrees).toEqual([]);
  });

  it('handles rows without an active_pid (claim window crashed before spawn)', async () => {
    const folder = ctx.folders.create('F');
    seedRunningRow(ctx, folder.id, null, 'auto-no-pid');
    const { stubs, sigtermPids, removedWorktrees } = makeStubs();
    const summary = await cancelInFlightForFolder(folder.id, {
      queue: ctx.queue,
      repoPath: '/tmp/repo',
      ...stubs,
    });
    expect(summary.cancelledCount).toBe(1);
    // No PID → no signal sent.
    expect(sigtermPids).toEqual([]);
    // But worktree still cleaned up.
    expect(removedWorktrees).toEqual(['auto-no-pid']);
  });
});

describe('cancelInFlightForFolder — partial failure tolerance', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('continues cleanup when a worktree removal errors', async () => {
    const folder = ctx.folders.create('F');
    seedRunningRow(ctx, folder.id, 3001, 'auto-clean');
    seedRunningRow(ctx, folder.id, 3002, 'auto-broken');
    seedRunningRow(ctx, folder.id, 3003, 'auto-also-clean');
    const { stubs, removedWorktrees } = makeStubs();
    stubs.removeError('auto-broken', 'permission denied');
    const summary = await cancelInFlightForFolder(folder.id, {
      queue: ctx.queue,
      repoPath: '/tmp/repo',
      killAfterTermMs: 10,
      ...stubs,
    });
    expect(summary.cancelledCount).toBe(3);
    expect(summary.worktreesRemoved).toBe(2);
    expect(summary.worktreeRemovalErrors).toEqual([
      { worktreeName: 'auto-broken', error: 'permission denied' },
    ]);
    // All 3 worktrees were ATTEMPTED.
    expect(removedWorktrees).toEqual(['auto-clean', 'auto-broken', 'auto-also-clean']);
    // All rows still get cancelled regardless.
    for (const r of ctx.queue.listInFlightForFolder(folder.id)) {
      expect(r).toBeUndefined(); // there should be no in-flight left
    }
  });

  it('swallows kill errors silently (process already exited)', async () => {
    const folder = ctx.folders.create('F');
    seedRunningRow(ctx, folder.id, 4001, 'auto-x');
    const { stubs, sigtermPids } = makeStubs();
    // Replace killProcess with a thrower (process gone before signal lands).
    const origKill = stubs.killProcess;
    stubs.killProcess = (pid, signal) => {
      if (signal === 'SIGTERM') {
        throw new Error('ESRCH: no such process');
      }
      origKill(pid, signal);
    };
    const summary = await cancelInFlightForFolder(folder.id, {
      queue: ctx.queue,
      repoPath: '/tmp/repo',
      killAfterTermMs: 10,
      ...stubs,
    });
    // The throw was swallowed; cancellation still completed.
    expect(summary.cancelledCount).toBe(1);
    // signaledPids tracks SUCCESSFUL signals — the throw means
    // signaledPids stays empty for that PID.
    expect(summary.signaledPids).toEqual([]);
    expect(sigtermPids).toEqual([]);
  });
});

describe('cancelInFlightForTask — kanban-move drift cancellation', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns null when the task has no in-flight row', async () => {
    const folder = ctx.folders.create('F');
    const task = ctx.notes.create({ body: '# T', folderId: folder.id, source: 'user' }, 'user');
    const { stubs } = makeStubs();
    const r = await cancelInFlightForTask(folder.id, task.id, {
      queue: ctx.queue,
      repoPath: '/tmp/repo',
      ...stubs,
    });
    expect(r).toBeNull();
  });

  it('cancels the in-flight row, SIGTERMs the PID, removes the worktree', async () => {
    const folder = ctx.folders.create('F');
    const seeded = seedRunningRow(ctx, folder.id, 7001, 'auto-target');
    seedRunningRow(ctx, folder.id, 7002, 'auto-other'); // unrelated row, must NOT cancel
    const { stubs, sigtermPids, removedWorktrees } = makeStubs();
    const r = await cancelInFlightForTask(folder.id, seeded.taskId, {
      queue: ctx.queue,
      repoPath: '/tmp/repo',
      killAfterTermMs: 50,
      ...stubs,
    });
    expect(r).not.toBeNull();
    expect(r!.cancelledCount).toBe(1);
    expect(r!.signaledPids).toEqual([7001]);
    expect(r!.worktreesRemoved).toBe(1);
    expect(sigtermPids).toEqual([7001]);
    expect(removedWorktrees).toEqual(['auto-target']);
    // Target row is cancelled.
    expect(ctx.queue.getById(seeded.rowId)?.state).toBe('cancelled');
    // Other row is untouched.
    expect(ctx.queue.listInFlightForFolder(folder.id).length).toBe(1);
  });

  it('preserves the cancellation reason on the row', async () => {
    const folder = ctx.folders.create('F');
    const seeded = seedRunningRow(ctx, folder.id, 7101, 'auto-reason');
    const { stubs } = makeStubs();
    await cancelInFlightForTask(folder.id, seeded.taskId, {
      queue: ctx.queue,
      repoPath: '/tmp/repo',
      reason: 'kanban-move:user:backlog',
      ...stubs,
    });
    expect(ctx.queue.getById(seeded.rowId)?.lastError).toBe('kanban-move:user:backlog');
  });

  it('escalates to SIGKILL when the PID ignores SIGTERM', async () => {
    const folder = ctx.folders.create('F');
    const seeded = seedRunningRow(ctx, folder.id, 7201, 'auto-stubborn');
    const { stubs, sigkillPids } = makeStubs({ stillAliveAfterTerm: [7201] });
    const r = await cancelInFlightForTask(folder.id, seeded.taskId, {
      queue: ctx.queue,
      repoPath: '/tmp/repo',
      killAfterTermMs: 50,
      ...stubs,
    });
    expect(sigkillPids).toEqual([7201]);
    expect(r!.forceKilledPids).toEqual([7201]);
  });

  it('does not crash when the row has no active_pid (claim crashed before spawn)', async () => {
    const folder = ctx.folders.create('F');
    const seeded = seedRunningRow(ctx, folder.id, null, 'auto-no-pid');
    const { stubs, sigtermPids, removedWorktrees } = makeStubs();
    const r = await cancelInFlightForTask(folder.id, seeded.taskId, {
      queue: ctx.queue,
      repoPath: '/tmp/repo',
      ...stubs,
    });
    expect(r!.cancelledCount).toBe(1);
    expect(sigtermPids).toEqual([]);
    expect(removedWorktrees).toEqual(['auto-no-pid']);
  });
});

describe('cancelInFlightForFolder — folder isolation', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('only cancels rows for the requested folder', async () => {
    const a = ctx.folders.create('A');
    const b = ctx.folders.create('B');
    seedRunningRow(ctx, a.id, 5001, 'auto-a');
    const seededB = seedRunningRow(ctx, b.id, 5002, 'auto-b');
    const { stubs, sigtermPids } = makeStubs();
    await cancelInFlightForFolder(a.id, {
      queue: ctx.queue,
      repoPath: '/tmp/repo',
      killAfterTermMs: 10,
      ...stubs,
    });
    // Only A's PID got signaled.
    expect(sigtermPids).toEqual([5001]);
    // B's row is untouched.
    expect(ctx.queue.getById(seededB.rowId)?.state).toBe('fix_running');
  });
});

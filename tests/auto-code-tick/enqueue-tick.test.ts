import { describe, expect, it } from 'vitest';
import {
  AUTO_CODE_AUDIT_CHECKPOINT_KEY,
  runAutoCodeEnqueueTick,
} from '../../src/server/features/auto-code-tick/index.js';
import { buildStubDispatcher, setup } from '../helpers/auto-code-tick-setup.js';

describe('runAutoCodeEnqueueTick', () => {
  it('drains audit_log status_change → todo rows for enabled folders', async () => {
    const ctx = setup();
    // Two notes that get moved to todo.
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    const t2 = ctx.notes.create(
      { body: '# T2', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');
    ctx.notes.moveToKanban(t2.id, 'todo', null, 'user');

    const { dispatcher, calls } = buildStubDispatcher(() => ({
      kind: 'enqueued',
      runId: 'r-' + Math.random(),
    }));
    const summary = await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });

    expect(summary.audited).toBe(2);
    expect(summary.enqueued).toBe(2);
    expect(calls.map((c) => c.noteId).sort()).toEqual([t1.id, t2.id].sort());
    // Checkpoint advanced.
    expect(summary.newCheckpoint).toBeGreaterThan(0);
    expect(
      ctx.settings.get<number>(AUTO_CODE_AUDIT_CHECKPOINT_KEY, 0),
    ).toBe(summary.newCheckpoint);
  });

  it('skips folders without auto_code_enabled', async () => {
    const ctx = setup();
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.folderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');

    const { dispatcher, calls } = buildStubDispatcher(() => ({
      kind: 'enqueued',
      runId: 'r1',
    }));
    const summary = await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(summary.audited).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('ignores moves authored by mcp:auto-code (no echo loop)', async () => {
    const ctx = setup();
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'mcp:auto-code');

    const { dispatcher, calls } = buildStubDispatcher(() => ({
      kind: 'enqueued',
      runId: 'r1',
    }));
    const summary = await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(summary.audited).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('does not re-process rows already past the checkpoint', async () => {
    const ctx = setup();
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');

    const { dispatcher, calls } = buildStubDispatcher(() => ({
      kind: 'enqueued',
      runId: 'r1',
    }));
    await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(calls).toHaveLength(1);
    // Second call with same audit state — checkpoint already advanced.
    await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(calls).toHaveLength(1);
  });

  it('records rejection reasons in summary', async () => {
    const ctx = setup();
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');
    const t2 = ctx.notes.create(
      { body: '# T2', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t2.id, 'todo', null, 'user');

    let i = 0;
    const { dispatcher } = buildStubDispatcher(() => {
      i += 1;
      if (i === 1) return { kind: 'rejected', reason: 'preflight_blocked' };
      return { kind: 'enqueued', runId: 'r' };
    });
    const summary = await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(summary.enqueued).toBe(1);
    expect(summary.rejected).toEqual({ preflight_blocked: 1 });
  });

  it('anti-strand: transient ticket_no_longer_todo on a still-todo card holds the checkpoint, next tick retries + enqueues', async () => {
    const ctx = setup();
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user'); // card is (and stays) in todo

    let call = 0;
    const { dispatcher, calls } = buildStubDispatcher(() => {
      call += 1;
      // First attempt loses a toggle race; the card is back in todo by
      // the time the tick re-checks, so it must be retried — not stranded.
      return call === 1
        ? { kind: 'rejected' as const, reason: 'ticket_no_longer_todo' }
        : { kind: 'enqueued' as const, runId: 'r1' };
    });

    const first = await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(first.enqueued).toBe(0);
    expect(first.rejected).toEqual({ ticket_no_longer_todo: 1 });

    // Checkpoint was held below the row → the next tick re-reads the SAME
    // row and this time succeeds. Without the fix the card would be
    // stranded in todo forever (checkpoint already past its only row).
    const second = await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(second.enqueued).toBe(1);
    expect(calls.map((c) => c.noteId)).toEqual([t1.id, t1.id]);
  });

  it('anti-strand does NOT hold when the card genuinely left todo (no infinite re-read)', async () => {
    const ctx = setup();
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');
    ctx.notes.moveToKanban(t1.id, 'backlog', null, 'user'); // moved out for good

    const { dispatcher, calls } = buildStubDispatcher(() => ({
      kind: 'rejected' as const,
      reason: 'ticket_no_longer_todo',
    }));
    const first = await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(first.rejected).toEqual({ ticket_no_longer_todo: 1 });

    // Card is in backlog now → checkpoint advances past the row → the
    // next tick sees nothing (no perpetual re-processing).
    const second = await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(second.audited).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('does not re-build dispatcher when zero audit rows match', async () => {
    const ctx = setup();
    let dispatcherBuilds = 0;
    const summary = await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => {
        dispatcherBuilds += 1;
        const stub = buildStubDispatcher([]).dispatcher;
        return stub;
      },
    });
    expect(summary.audited).toBe(0);
    expect(dispatcherBuilds).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  AUTO_CODE_AUDIT_CHECKPOINT_KEY,
  runAutoCodeEnqueueTick,
  runAutoCodeStartupSweep,
} from '../../src/server/features/auto-code-tick/index.js';
import {
  buildStubDispatcher,
  folderSweepKey,
  setup,
} from '../helpers/auto-code-tick-setup.js';

describe('Codex T7.B.2.d round 2 regressions', () => {
  it('P1.1: folder enabled AFTER first sweep gets its todos picked up', async () => {
    const ctx = setup();
    // First sweep: enabled folder is empty; only the disabled folder
    // has the candidate ticket. Sweep marks the empty folder done.
    let firstCalls = 0;
    const firstStub = buildStubDispatcher(() => {
      firstCalls += 1;
      return { kind: 'enqueued', runId: 'r1' };
    });
    await runAutoCodeStartupSweep({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => firstStub.dispatcher,
    });
    expect(firstCalls).toBe(0);
    // Now the user enables auto-code on the previously-disabled folder.
    ctx.folderSettings.update(ctx.folderId, {
      enabled: true,
      autoCodeEnabled: true,
      linkedRepoPath: '/tmp/morion-test',
    });
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.folderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');

    // Second sweep: should pick up the freshly-enabled folder.
    const { dispatcher: secondDispatcher, calls: secondCalls } =
      buildStubDispatcher(() => ({ kind: 'enqueued', runId: 'r2' }));
    await runAutoCodeStartupSweep({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => secondDispatcher,
    });
    expect(secondCalls.map((c) => c.noteId)).toEqual([t1.id]);
  });

  it('P1.2: notes_create with status=todo is picked up by audit tick', async () => {
    const ctx = setup();
    // Bypass moveToKanban — write `status: 'todo'` directly on create.
    // This produces ONLY an `action='create'` audit row, no
    // status_change row. The tick must still pick it up.
    const t1 = ctx.notes.create(
      {
        body: '# T1',
        folderId: ctx.enabledFolderId,
        source: 'user',
        status: 'todo',
      },
      'user',
    );
    const { dispatcher, calls } = buildStubDispatcher(() => ({
      kind: 'enqueued',
      runId: 'r1',
    }));
    const summary = await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(summary.audited).toBe(1);
    expect(calls).toEqual([{ noteId: t1.id, folderId: ctx.enabledFolderId }]);
  });

  it('P1.2 negative: notes_create with status=note (default) is NOT picked up', async () => {
    const ctx = setup();
    ctx.notes.create(
      { body: '# T', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    // Default status='note' — this note does NOT belong on kanban
    // and must not trigger autocode.
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

  it('P1.3: checkpoint NOT advanced when buildDispatcher throws', async () => {
    const ctx = setup();
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');
    const checkpointBefore = ctx.settings.get<number>(
      AUTO_CODE_AUDIT_CHECKPOINT_KEY,
      0,
    );
    expect(checkpointBefore).toBe(0);

    // First tick: buildDispatcher throws — checkpoint must stay at 0
    // so the row is retried on the next tick.
    const summary = await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => {
        throw new Error('claude binary not yet detected');
      },
    });
    expect(summary.audited).toBe(1); // SELECT saw the row
    expect(summary.enqueued).toBe(0);
    expect(summary.newCheckpoint).toBe(0); // checkpoint unchanged
    expect(
      ctx.settings.get<number>(AUTO_CODE_AUDIT_CHECKPOINT_KEY, 0),
    ).toBe(0);

    // Second tick (dispatcher now works) re-reads the same row.
    const { dispatcher, calls } = buildStubDispatcher(() => ({
      kind: 'enqueued',
      runId: 'r1',
    }));
    await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(calls.map((c) => c.noteId)).toEqual([t1.id]);
  });

  it('P1.4: sweep marker NOT set when ANY enqueueTicket throws', async () => {
    const ctx = setup();
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

    let i = 0;
    const { dispatcher } = buildStubDispatcher(() => {
      i += 1;
      if (i === 1) throw new Error('transient');
      return { kind: 'enqueued', runId: 'r' };
    });
    await runAutoCodeStartupSweep({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    // Folder marker NOT set — at least one ticket threw, so retry on next poll.
    expect(
      ctx.settings.get<number>(folderSweepKey(ctx.enabledFolderId), 0),
    ).toBe(0);
  });

  it('P1.4: sweep marker IS set when all rejections are deterministic (no throws)', async () => {
    const ctx = setup();
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');
    const { dispatcher } = buildStubDispatcher(() => ({
      kind: 'rejected',
      reason: 'preflight_blocked',
    }));
    await runAutoCodeStartupSweep({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    // Folder marker SET — rejections are deterministic gate failures
    // that won't change without a config flip; not worth retrying
    // every poll forever.
    expect(
      ctx.settings.get<number>(folderSweepKey(ctx.enabledFolderId), 0),
    ).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';
import { runAutoCodeStartupSweep } from '../../src/server/features/auto-code-tick/index.js';
import {
  buildStubDispatcher,
  folderSweepKey,
  setup,
} from '../helpers/auto-code-tick-setup.js';

describe('runAutoCodeStartupSweep', () => {
  it('enqueues every todo ticket in enabled folders that has no active run', async () => {
    const ctx = setup();
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    const t2 = ctx.notes.create(
      { body: '# T2', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    // Pre-existing in todo (e.g. user prepared the board, then enabled).
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');
    ctx.notes.moveToKanban(t2.id, 'todo', null, 'user');

    const { dispatcher, calls } = buildStubDispatcher(() => ({
      kind: 'enqueued',
      runId: 'r' + Math.random(),
    }));
    const summary = await runAutoCodeStartupSweep({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(summary.audited).toBe(2);
    expect(summary.enqueued).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('skips tickets that already have an active workflow_run', async () => {
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

    // Seed an active workflow_run for t1.
    ctx.runsRepo.createRun({
      folderId: ctx.enabledFolderId,
      ticketId: t1.id,
      graphSnapshot: {
        schemaVersion: 1 as const,
        name: 'X',
        description: '',
        stages: [
          {
            id: 'a',
            kind: 'cli_agent' as const,
            agent: 'claude' as const,
            promptTemplate: 'a',
            maxBudgetUsd: null,
            maxAttempts: 1,
            allowedTools: [],
          },
        ],
        edges: [],
      },
      repoPath: '/tmp/x',
      worktreePath: '/tmp/x/wt',
      initialStatus: 'running',
    });

    const { dispatcher, calls } = buildStubDispatcher(() => ({
      kind: 'enqueued',
      runId: 'r1',
    }));
    const summary = await runAutoCodeStartupSweep({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(summary.audited).toBe(1);
    expect(calls.map((c) => c.noteId)).toEqual([t2.id]);
  });

  it('idempotent — second call without force is a no-op', async () => {
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
    await runAutoCodeStartupSweep({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(calls).toHaveLength(1);
    // Sweep marker persisted.
    expect(
      ctx.settings.get<number>(folderSweepKey(ctx.enabledFolderId), 0),
    ).toBeGreaterThan(0);

    // Second call WITHOUT force: no scan, no enqueue.
    const summary = await runAutoCodeStartupSweep({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(summary.audited).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('force=true re-runs the scan even if marker is set', async () => {
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
    await runAutoCodeStartupSweep({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
    });
    expect(calls).toHaveLength(1);
    await runAutoCodeStartupSweep(
      {
        db: ctx.db,
        workspaceSettings: ctx.settings,
        buildDispatcher: async () => dispatcher,
      },
      { force: true },
    );
    expect(calls).toHaveLength(2);
  });

  it('does not mark sweep done when buildDispatcher throws (retries next start)', async () => {
    const ctx = setup();
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');

    await runAutoCodeStartupSweep({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => {
        throw new Error('not configured');
      },
    });
    // Marker NOT set — next startup will retry.
    expect(
      ctx.settings.get<number>(folderSweepKey(ctx.enabledFolderId), 0),
    ).toBe(0);
  });
});

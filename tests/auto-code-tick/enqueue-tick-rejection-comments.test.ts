import { describe, expect, it } from 'vitest';
import { runAutoCodeEnqueueTick } from '../../src/server/features/auto-code-tick/index.js';
import { buildStubDispatcher, setup } from '../helpers/auto-code-tick-setup.js';

describe('runAutoCodeEnqueueTick — rejection comments (Fix B for ticket 01KRFPCCZBC40ATQCHY1FPJ8KP)', () => {
  it('posts a visible rejection comment when dispatcher rejects with workflow_not_runnable', async () => {
    const { NoteCommentsRepository } = await import(
      '../../src/core/notes/comments-repository.js'
    );
    const ctx = setup();
    const comments = new NoteCommentsRepository(ctx.db);
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');

    const { dispatcher } = buildStubDispatcher(() => ({
      kind: 'rejected',
      reason: 'workflow_not_runnable',
      missingDetails: [
        'Workflow "Default Mo-driven" contains a stage kind not yet supported by the runner.',
        'stage[3] (id="gate9") has kind="human_gate" which is reserved',
      ],
    }));
    const summary = await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
      comments,
    });
    expect(summary.rejected).toEqual({ workflow_not_runnable: 1 });

    // The ticket now carries a visible comment from mcp:auto-code
    // explaining the issue.
    const list = comments.list(t1.id, { limit: 5 });
    expect(list.items.length).toBe(1);
    const c = list.items[0]!;
    expect(c.actor).toBe('mcp:auto-code');
    expect(c.body).toContain("Auto-code can't run this ticket");
    expect(c.body).toContain('human_gate'); // detail line bubbled through
    expect(c.body).toContain('Folder Settings'); // recovery hint
  });

  it('dedups rejection comments within 24h (no spam on persistent issue)', async () => {
    const { NoteCommentsRepository } = await import(
      '../../src/core/notes/comments-repository.js'
    );
    const ctx = setup();
    const comments = new NoteCommentsRepository(ctx.db);
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');

    const { dispatcher } = buildStubDispatcher(() => ({
      kind: 'rejected',
      reason: 'workflow_not_runnable',
      missingDetails: ['stage[0] kind="human_gate" reserved'],
    }));
    // First tick — comment posted.
    await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
      comments,
    });
    expect(comments.list(t1.id, { limit: 5 }).items.length).toBe(1);

    // User re-drags backlog→todo to retry. Same rejection fires.
    ctx.notes.moveToKanban(t1.id, 'backlog', null, 'user');
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');
    await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
      comments,
    });
    // Still ONE comment — dedup gate held.
    expect(comments.list(t1.id, { limit: 5 }).items.length).toBe(1);
  });

  it('does NOT post comment for benign rejections (auto_code_disabled, folder_cap_exceeded)', async () => {
    const { NoteCommentsRepository } = await import(
      '../../src/core/notes/comments-repository.js'
    );
    const ctx = setup();
    const comments = new NoteCommentsRepository(ctx.db);
    const t1 = ctx.notes.create(
      { body: '# T1', folderId: ctx.enabledFolderId, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(t1.id, 'todo', null, 'user');

    const { dispatcher } = buildStubDispatcher(() => ({
      kind: 'rejected',
      reason: 'folder_cap_exceeded',
    }));
    await runAutoCodeEnqueueTick({
      db: ctx.db,
      workspaceSettings: ctx.settings,
      buildDispatcher: async () => dispatcher,
      comments,
    });
    // Concurrency-cap is a "we'll get to it" signal, NOT a failure —
    // no user-facing comment.
    expect(comments.list(t1.id, { limit: 5 }).items.length).toBe(0);
  });
});

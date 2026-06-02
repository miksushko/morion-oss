import { describe, it, expect, beforeEach } from 'vitest';
import {
  tasksListTool,
  tasksMoveTool,
  tasksClaimTool,
  tasksHistoryTool,
  foldersSetViewModeTool,
} from '../../src/server/tools/index.js';
import type { Note, Folder } from '../../src/core/notes/types.js';
import { createKanbanFolder, setup, type Ctx } from '../helpers/tasks-setup.js';

describe('Direction N — MCP tool layer', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  describe('folders_set_view_mode', () => {
    it('flips a folder and returns the updated shape', async () => {
      const f = ctx.tc.folders.create('Project');
      const result = (await foldersSetViewModeTool.handler(
        { folderId: f.id, mode: 'kanban' },
        ctx.tc,
      )) as Folder;
      expect(result.viewMode).toBe('kanban');
    });

    it('returns mcp_access_denied for a bogus id (visibility gate fires first)', async () => {
      const result = (await foldersSetViewModeTool.handler(
        { folderId: 'nope', mode: 'kanban' },
        ctx.tc,
      )) as { error: string };
      expect(result.error).toBe('mcp_access_denied');
    });
  });

  describe('tasks_list', () => {
    it('returns folder_not_kanban for a list-mode folder', async () => {
      const f = ctx.tc.folders.create('Plain');
      ctx.tc.notes.create({ body: 'note', source: 'user', folderId: f.id }, 'user');
      const result = (await tasksListTool.handler(
        { folderId: f.id, limit: 50 },
        ctx.tc,
      )) as { error?: string; tasks: Note[] };
      expect(result.error).toBe('folder_not_kanban');
      expect(result.tasks).toEqual([]);
    });

    it('returns tasks sorted by column for a kanban folder', async () => {
      const f = await createKanbanFolder(ctx, 'Kanban');
      ctx.tc.notes.create({ body: 'idea', source: 'user', folderId: f.id, status: 'note' }, 'user');
      ctx.tc.notes.create({ body: 'task', source: 'user', folderId: f.id, status: 'todo' }, 'user');
      const result = (await tasksListTool.handler(
        { folderId: f.id, limit: 50 },
        ctx.tc,
      )) as { folder: { id: string }; tasks: Note[] };
      expect(result.folder.id).toBe(f.id);
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0]?.status).toBe('note');
      expect(result.tasks[1]?.status).toBe('todo');
    });

    it('filters by status', async () => {
      const f = await createKanbanFolder(ctx, 'Kanban');
      ctx.tc.notes.create({ body: 'a', source: 'user', folderId: f.id, status: 'todo' }, 'user');
      ctx.tc.notes.create({ body: 'b', source: 'user', folderId: f.id, status: 'doing' }, 'user');
      const result = (await tasksListTool.handler(
        { folderId: f.id, status: 'todo', limit: 50 },
        ctx.tc,
      )) as { tasks: Note[] };
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.status).toBe('todo');
    });
  });

  describe('tasks_move', () => {
    it('moves a card between columns and writes audit', async () => {
      const f = await createKanbanFolder(ctx, 'K');
      const n = ctx.tc.notes.create(
        { body: 'x', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      const result = (await tasksMoveTool.handler(
        { id: n.id, status: 'doing' },
        ctx.tc,
      )) as Note;
      expect(result.status).toBe('doing');
      const history = ctx.tc.audit.statusHistory(n.id, 5);
      expect(history[0]).toMatchObject({ statusFrom: 'todo', statusTo: 'doing' });
    });

    it('refuses to move a note in a list-mode folder', async () => {
      const f = ctx.tc.folders.create('Plain');
      const n = ctx.tc.notes.create(
        { body: 'x', source: 'user', folderId: f.id },
        'user',
      );
      const result = (await tasksMoveTool.handler(
        { id: n.id, status: 'doing' },
        ctx.tc,
      )) as { error: string };
      expect(result.error).toBe('folder_not_kanban');
    });

    // -------------------------------------------------------------
    // Direction Q Phase Q4 — optional `message` + auto-post
    // -------------------------------------------------------------

    it('auto-posts a comment when `message` is provided', async () => {
      const f = await createKanbanFolder(ctx, 'K');
      const n = ctx.tc.notes.create(
        { body: 'x', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      const result = (await tasksMoveTool.handler(
        { id: n.id, status: 'doing', message: 'starting work on this' },
        ctx.tc,
      )) as Note;
      expect(result.status).toBe('doing');

      const { items } = ctx.tc.comments.list(n.id, { limit: 10 });
      expect(items).toHaveLength(1);
      expect(items[0]!.body).toBe('Moved to doing: starting work on this');
      expect(items[0]!.actor).toBe('mcp:test-agent');
    });

    it('does NOT auto-post when `message` is empty or whitespace-only', async () => {
      const f = await createKanbanFolder(ctx, 'K');
      const n = ctx.tc.notes.create(
        { body: 'x', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      await tasksMoveTool.handler({ id: n.id, status: 'doing', message: '   ' }, ctx.tc);
      expect(ctx.tc.comments.list(n.id, { limit: 10 }).items).toHaveLength(0);
    });

    it('requires a message from MCP actors when setting is on', async () => {
      const f = await createKanbanFolder(ctx, 'K');
      const n = ctx.tc.notes.create(
        { body: 'x', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      ctx.tc.settings.setRequireLlmStatusComment(true);

      const result = (await tasksMoveTool.handler(
        { id: n.id, status: 'doing' },
        ctx.tc,
      )) as { error: string };
      expect(result.error).toBe('status_comment_required');
      // Nothing moved, nothing posted.
      expect(ctx.tc.notes.getById(n.id)?.status).toBe('todo');
      expect(ctx.tc.comments.list(n.id, { limit: 10 }).items).toHaveLength(0);
    });

    it('accepts MCP move with a non-empty message when setting is on', async () => {
      const f = await createKanbanFolder(ctx, 'K');
      const n = ctx.tc.notes.create(
        { body: 'x', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      ctx.tc.settings.setRequireLlmStatusComment(true);

      const result = (await tasksMoveTool.handler(
        { id: n.id, status: 'doing', message: 'picked up the ticket' },
        ctx.tc,
      )) as Note;
      expect(result.status).toBe('doing');
      const { items } = ctx.tc.comments.list(n.id, { limit: 10 });
      expect(items).toHaveLength(1);
    });

    it('does NOT require message from user actor even when setting is on', async () => {
      const f = await createKanbanFolder(ctx, 'K');
      const n = ctx.tc.notes.create(
        { body: 'x', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      ctx.tc.settings.setRequireLlmStatusComment(true);

      // User-actor context — require toggle should NOT fire.
      const userCtx = { ...ctx.tc, actor: 'user' };
      const result = (await tasksMoveTool.handler(
        { id: n.id, status: 'doing' },
        userCtx,
      )) as Note;
      expect(result.status).toBe('doing');
      expect(ctx.tc.comments.list(n.id, { limit: 10 }).items).toHaveLength(0);
    });
  });

  describe('tasks_claim', () => {
    it('exactly one of N concurrent claim attempts succeeds', async () => {
      const f = await createKanbanFolder(ctx, 'K');
      const n = ctx.tc.notes.create(
        { body: 'race', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );

      // better-sqlite3 is synchronous single-threaded, so true concurrency
      // isn't possible inside a single process. But the race-condition
      // primitive's correctness is about the atomic UPDATE, which we verify
      // by running N sequential claims against the same note and asserting
      // exactly one succeeds.
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          tasksClaimTool.handler({ id: n.id }, {
            ...ctx.tc,
            actor: `mcp:agent-${i}`,
          }),
        ),
      );
      const claimed = results.filter((r) => (r as { claimed: boolean }).claimed);
      expect(claimed).toHaveLength(1);
    });

    it('returns claimed:false for a non-todo task', async () => {
      const f = await createKanbanFolder(ctx, 'K');
      const n = ctx.tc.notes.create(
        { body: 'x', source: 'user', folderId: f.id, status: 'backlog' },
        'user',
      );
      const result = (await tasksClaimTool.handler({ id: n.id }, ctx.tc)) as {
        claimed: boolean;
        currentStatus: string;
      };
      expect(result.claimed).toBe(false);
      expect(result.currentStatus).toBe('backlog');
    });
  });

  describe('tasks_history', () => {
    it('returns only status_change rows in reverse chronological order', async () => {
      const f = await createKanbanFolder(ctx, 'K');
      const n = ctx.tc.notes.create(
        { body: 'x', source: 'user', folderId: f.id, status: 'todo' },
        'user',
      );
      // A create + a read + a status change should yield exactly 1 history row.
      ctx.tc.notes.getById(n.id, { audit: true, actor: 'user' });
      ctx.tc.notes.claimTask(n.id, 'mcp:agent');

      const result = (await tasksHistoryTool.handler(
        { id: n.id, limit: 50 },
        ctx.tc,
      )) as {
        history: Array<{ statusFrom: string; statusTo: string }>;
      };
      expect(result.history).toHaveLength(1);
      expect(result.history[0]).toMatchObject({ statusFrom: 'todo', statusTo: 'doing' });
    });

    it('returns mcp_access_denied for a bogus id (visibility gate fires first)', async () => {
      const result = (await tasksHistoryTool.handler(
        { id: 'nope', limit: 10 },
        ctx.tc,
      )) as { error: string };
      expect(result.error).toBe('mcp_access_denied');
    });
  });
});

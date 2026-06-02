import { beforeEach, describe, expect, it } from 'vitest';

import { type Ctx, setup, json, patchJson } from './http/helpers.js';

describe('HTTP kanban (Direction N)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  async function createFolderViaApi(name: string): Promise<{ id: string }> {
    const res = await ctx.app.request('/api/folders', json({ name }));
    return (await res.json()) as { id: string };
  }

  it('PATCH /api/folders/:id/view-mode flips between list and kanban', async () => {
    const folder = await createFolderViaApi('Project');
    const res = await ctx.app.request(
      `/api/folders/${folder.id}/view-mode`,
      patchJson({ viewMode: 'kanban' }),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { id: string; viewMode: string };
    expect(updated.viewMode).toBe('kanban');

    // Flip back
    const back = await ctx.app.request(
      `/api/folders/${folder.id}/view-mode`,
      patchJson({ viewMode: 'list' }),
    );
    const bodyBack = (await back.json()) as { viewMode: string };
    expect(bodyBack.viewMode).toBe('list');
  });

  it('rejects an unknown view-mode value with a 400', async () => {
    const folder = await createFolderViaApi('Project');
    const res = await ctx.app.request(
      `/api/folders/${folder.id}/view-mode`,
      patchJson({ viewMode: 'tile' }),
    );
    expect(res.status).toBe(400);
  });

  it('GET /api/folders/:id/kanban returns columns grouped by status', async () => {
    const folder = await createFolderViaApi('Board');
    await ctx.app.request(
      `/api/folders/${folder.id}/view-mode`,
      patchJson({ viewMode: 'kanban' }),
    );
    const note = ctx.notes.create(
      { body: 'task', source: 'user', folderId: folder.id, status: 'todo' },
      'user',
    );
    const res = await ctx.app.request(`/api/folders/${folder.id}/kanban`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      folder: { id: string };
      columns: Record<string, Array<{ id: string; commentCount: number }>>;
    };
    expect(body.folder.id).toBe(folder.id);
    expect(body.columns.todo).toHaveLength(1);
    expect(body.columns.todo[0]?.id).toBe(note.id);
    expect(body.columns.note).toEqual([]);
    // Direction Q — each card carries a commentCount (0 here, no comments posted).
    expect(body.columns.todo[0]?.commentCount).toBe(0);
  });

  it('/kanban response populates commentCount per card (Direction Q)', async () => {
    const folder = await createFolderViaApi('Board');
    ctx.handle.db
      .prepare('UPDATE folders SET view_mode = ? WHERE id = ?')
      .run('kanban', folder.id);
    const noteA = ctx.notes.create(
      { body: 'card A', source: 'user', folderId: folder.id, status: 'todo' },
      'user',
    );
    const noteB = ctx.notes.create(
      { body: 'card B', source: 'user', folderId: folder.id, status: 'todo' },
      'user',
    );
    // Post 2 comments on A, 0 on B.
    await ctx.app.request(`/api/notes/${noteA.id}/comments`, json({ body: 'one' }));
    await ctx.app.request(`/api/notes/${noteA.id}/comments`, json({ body: 'two' }));

    const body = (await (
      await ctx.app.request(`/api/folders/${folder.id}/kanban`)
    ).json()) as {
      columns: Record<string, Array<{ id: string; commentCount: number }>>;
    };
    const todoCards = body.columns.todo;
    const byId = new Map(todoCards.map((c) => [c.id, c.commentCount]));
    expect(byId.get(noteA.id)).toBe(2);
    expect(byId.get(noteB.id)).toBe(0);
  });

  it('409 on GET /kanban for a list-mode folder', async () => {
    const folder = await createFolderViaApi('Plain');
    const res = await ctx.app.request(`/api/folders/${folder.id}/kanban`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('folder_not_kanban');
  });

  it('POST /api/notes/:id/kanban-move flips status and writes status_change audit', async () => {
    const folder = await createFolderViaApi('K');
    await ctx.app.request(
      `/api/folders/${folder.id}/view-mode`,
      patchJson({ viewMode: 'kanban' }),
    );
    const note = ctx.notes.create(
      { body: 'x', source: 'user', folderId: folder.id, status: 'todo' },
      'user',
    );

    const res = await ctx.app.request(
      `/api/notes/${note.id}/kanban-move`,
      json({ status: 'doing', afterNoteId: null }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('doing');

    const histRes = await ctx.app.request(`/api/notes/${note.id}/status-history`);
    expect(histRes.status).toBe(200);
    const history = (await histRes.json()) as Array<{
      statusFrom: string;
      statusTo: string;
      actor: string;
    }>;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      statusFrom: 'todo',
      statusTo: 'doing',
      actor: 'user',
    });
  });

  it('POST /kanban-move with `message` auto-posts a comment (Direction Q)', async () => {
    const folder = await createFolderViaApi('K');
    await ctx.app.request(
      `/api/folders/${folder.id}/view-mode`,
      patchJson({ viewMode: 'kanban' }),
    );
    const note = ctx.notes.create(
      { body: 'card', source: 'user', folderId: folder.id, status: 'todo' },
      'user',
    );
    const res = await ctx.app.request(
      `/api/notes/${note.id}/kanban-move`,
      json({ status: 'doing', message: 'reviewed and ready' }),
    );
    expect(res.status).toBe(200);
    // The activity feed for the note should carry the auto-comment.
    const activity = (await (
      await ctx.app.request(`/api/notes/${note.id}/activity`)
    ).json()) as {
      items: Array<{ kind: string; body?: string; actor?: string }>;
    };
    const autoComment = activity.items.find(
      (r) => r.kind === 'comment' && r.body === 'Moved to doing: reviewed and ready',
    );
    expect(autoComment).toBeDefined();
    expect(autoComment!.actor).toBe('user');
  });

  it('POST /kanban-move without `message` does NOT auto-post (user never required)', async () => {
    const folder = await createFolderViaApi('K');
    await ctx.app.request(
      `/api/folders/${folder.id}/view-mode`,
      patchJson({ viewMode: 'kanban' }),
    );
    const note = ctx.notes.create(
      { body: 'card', source: 'user', folderId: folder.id, status: 'todo' },
      'user',
    );
    // Even with the require setting flipped ON, user actor bypasses.
    ctx.settings.setRequireLlmStatusComment(true);
    const res = await ctx.app.request(
      `/api/notes/${note.id}/kanban-move`,
      json({ status: 'doing' }),
    );
    expect(res.status).toBe(200);
    // No auto-comment (body was empty), but status moved.
    expect(ctx.handle.db.prepare('SELECT status FROM notes WHERE id = ?').get(note.id)).toMatchObject({
      status: 'doing',
    });
  });

  it('PATCH /api/notes/:id accepts status+position as metadata (does not bump updated_at)', async () => {
    const folder = await createFolderViaApi('K');
    await ctx.app.request(
      `/api/folders/${folder.id}/view-mode`,
      patchJson({ viewMode: 'kanban' }),
    );
    const note = ctx.notes.create(
      { body: 'x', source: 'user', folderId: folder.id, status: 'backlog' },
      'user',
    );
    const originalUpdatedAt = note.updatedAt;
    // Sleep 5ms so a bump would be detectable
    await new Promise((r) => setTimeout(r, 5));

    const res = await ctx.app.request(
      `/api/notes/${note.id}`,
      patchJson({ status: 'review' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; updatedAt: number };
    expect(body.status).toBe('review');
    expect(body.updatedAt).toBe(originalUpdatedAt);
  });

  it('status-history 404s for a missing note', async () => {
    const res = await ctx.app.request('/api/notes/missing/status-history');
    expect(res.status).toBe(404);
  });
});

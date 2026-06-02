import { beforeEach, describe, expect, it } from 'vitest';

import { type Ctx, setup, json, patchJson } from './http/helpers.js';

describe('HTTP /api/notes/:id/activity + /api/comments', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  async function createNote(body = '# A\n\nb'): Promise<{ id: string }> {
    const res = await ctx.app.request('/api/notes', json({ body }));
    return (await res.json()) as { id: string };
  }

  it('GET /activity returns UNION feed + X-Total-Count header', async () => {
    const note = await createNote();
    await ctx.app.request(
      `/api/notes/${note.id}/comments`,
      json({ body: 'hello' }),
    );
    const res = await ctx.app.request(`/api/notes/${note.id}/activity`);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Total-Count')).toBe('2'); // 1 create + 1 comment
    const payload = (await res.json()) as {
      items: Array<{ kind: string; body?: string; action?: string }>;
      nextCursor: string | null;
      total: number;
    };
    expect(payload.items).toHaveLength(2);
    expect(payload.total).toBe(2);
    expect(payload.items[0]!.kind).toBe('comment');
    expect(payload.items[0]!.body).toBe('hello');
    expect(payload.items[1]!.action).toBe('create');
  });

  it('GET /activity default limit is 20 + cursor paginates', async () => {
    const note = await createNote();
    // 25 comments → first page fills to 20, second page returns 6 (create + 5 remaining comments).
    for (let i = 0; i < 25; i++) {
      await ctx.app.request(
        `/api/notes/${note.id}/comments`,
        json({ body: `c${i}` }),
      );
    }
    const p1 = await ctx.app.request(`/api/notes/${note.id}/activity`);
    const p1Body = (await p1.json()) as { items: unknown[]; nextCursor: string | null };
    expect(p1Body.items).toHaveLength(20);
    expect(p1Body.nextCursor).not.toBeNull();

    const p2 = await ctx.app.request(
      `/api/notes/${note.id}/activity?cursor=${encodeURIComponent(p1Body.nextCursor!)}`,
    );
    const p2Body = (await p2.json()) as { items: unknown[]; nextCursor: string | null };
    // Remaining 5 comments + 1 create audit row = 6.
    expect(p2Body.items).toHaveLength(6);
    expect(p2Body.nextCursor).toBeNull();
  });

  it('GET /activity rejects limit > 200', async () => {
    const note = await createNote();
    const res = await ctx.app.request(`/api/notes/${note.id}/activity?limit=500`);
    expect(res.status).toBe(400);
  });

  it('GET /activity returns 404 for a missing note', async () => {
    const res = await ctx.app.request('/api/notes/nope/activity');
    expect(res.status).toBe(404);
  });

  it('POST /comments creates + returns the row', async () => {
    const note = await createNote();
    const res = await ctx.app.request(
      `/api/notes/${note.id}/comments`,
      json({ body: 'first' }),
    );
    expect(res.status).toBe(201);
    const comment = (await res.json()) as {
      id: string;
      body: string;
      actor: string;
      parentId: string | null;
      updatedAt: number | null;
    };
    expect(comment.body).toBe('first');
    expect(comment.actor).toBe('user'); // HTTP layer stamps user
    expect(comment.parentId).toBeNull();
    expect(comment.updatedAt).toBeNull();
  });

  it('POST /comments rejects nested reply with 400', async () => {
    const note = await createNote();
    const parent = (await (
      await ctx.app.request(
        `/api/notes/${note.id}/comments`,
        json({ body: 'top' }),
      )
    ).json()) as { id: string };
    const reply = (await (
      await ctx.app.request(
        `/api/notes/${note.id}/comments`,
        json({ body: 're', parentId: parent.id }),
      )
    ).json()) as { id: string };
    const rejected = await ctx.app.request(
      `/api/notes/${note.id}/comments`,
      json({ body: 're-re', parentId: reply.id }),
    );
    expect(rejected.status).toBe(400);
    const body = (await rejected.json()) as { error: string };
    expect(body.error).toBe('nested_reply_rejected');
  });

  it('PATCH /comments/:id edits body + stamps updated_at', async () => {
    const note = await createNote();
    const created = (await (
      await ctx.app.request(
        `/api/notes/${note.id}/comments`,
        json({ body: 'original' }),
      )
    ).json()) as { id: string };
    const res = await ctx.app.request(
      `/api/comments/${created.id}`,
      patchJson({ body: 'edited' }),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as { body: string; updatedAt: number | null };
    expect(updated.body).toBe('edited');
    expect(updated.updatedAt).not.toBeNull();
  });

  it('PATCH /comments/:id rejects when editing another actor\'s comment with 403', async () => {
    const note = await createNote();
    // Comment owned by 'user' (HTTP-stamped). Simulate foreign actor by
    // writing a row directly as 'mcp:other' — UI's actor='user' shouldn't
    // be able to edit it.
    const other = ctx.comments.create(note.id, 'by mcp', 'mcp:other')!;
    const res = await ctx.app.request(
      `/api/comments/${other.id}`,
      patchJson({ body: 'hijack' }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('comment_actor_mismatch');
  });

  it('DELETE /comments/:id removes row + writes comment_delete tombstone', async () => {
    const note = await createNote();
    const created = (await (
      await ctx.app.request(
        `/api/notes/${note.id}/comments`,
        json({ body: 'remove me' }),
      )
    ).json()) as { id: string };
    const res = await ctx.app.request(`/api/comments/${created.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    // Audit feed should have the tombstone.
    const activity = await (
      await ctx.app.request(`/api/notes/${note.id}/activity`)
    ).json();
    const events = (activity as {
      items: Array<{ kind: string; action?: string }>;
    }).items;
    expect(events.some((r) => r.kind === 'event' && r.action === 'comment_delete')).toBe(true);
  });

  it('DELETE /comments/:id returns 404 for a missing id', async () => {
    const res = await ctx.app.request('/api/comments/no-such-id', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});

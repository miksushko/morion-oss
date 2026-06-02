import { beforeEach, describe, expect, it } from 'vitest';

import { type Ctx, activateProHttp, setup, json, patchJson } from './http/helpers.js';

describe('HTTP /api/notes GET pagination', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('emits X-Total-Count with the full filtered size regardless of limit', async () => {
    // UI uses this header to decide whether to keep loading more pages.
    // If it ever goes missing or reports the page size instead of the full
    // size, the "N of M" badge and infinite scroll both break silently.
    for (let i = 0; i < 12; i++) {
      const res = await ctx.app.request('/api/notes', json({ body: `N${i}` }));
      expect(res.status).toBe(201);
    }

    const page = await ctx.app.request('/api/notes?limit=5&offset=0');
    expect(page.status).toBe(200);
    expect(page.headers.get('X-Total-Count')).toBe('12');
    const first = (await page.json()) as { id: string }[];
    expect(first).toHaveLength(5);

    const rest = await ctx.app.request('/api/notes?limit=100&offset=5');
    expect(rest.headers.get('X-Total-Count')).toBe('12');
    const tail = (await rest.json()) as { id: string }[];
    expect(tail).toHaveLength(7);
  });

  it('returns a structured 400 on a bad pagination query', async () => {
    const res = await ctx.app.request('/api/notes?limit=not-a-number');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation');
  });

  it('user UI sees notes in invisible folders on Pro (regression 2026-04-25)', async () => {
    // CRITICAL bug: a Pro user toggling "Visible to AI = false" on a
    // folder lost access to their own notes in the UI — they looked
    // soft-deleted. HTTP routes use actor='user', and MCP permissions
    // must NEVER gate user UI. They gate only mcp:* actors.
    //
    // History: this test originally asserted the OPPOSITE — audit N2
    // (2026-04-16) added filterReadable to /api/notes' X-Total-Count to
    // hide note counts from "the Pro caller" without realising the HTTP
    // caller is always the user, not an MCP client. That was a metadata-
    // leak fix that overshot into a data-loss bug. Rewritten 2026-04-25
    // to pin the correct behaviour.
    const hidden = ctx.folders.create('Hidden');
    const open = ctx.folders.create('Open');
    ctx.notes.create({ body: 'secret-A', folderId: hidden.id, source: 'user' }, 'user');
    ctx.notes.create({ body: 'secret-B', folderId: hidden.id, source: 'user' }, 'user');
    ctx.notes.create({ body: 'open-A', folderId: open.id, source: 'user' }, 'user');

    ctx.folders.setMcpPermissions(hidden.id, {
      visible: false,
      create: true,
      update: true,
      delete: true,
    });

    activateProHttp(ctx.settings);

    // User UI: every note is visible. Total = 3.
    const res = await ctx.app.request('/api/notes?limit=100');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Total-Count')).toBe('3');
    const rows = (await res.json()) as { id: string; body: string }[];
    expect(rows).toHaveLength(3);

    // Filtered by the hidden folder id directly: user can still open
    // their own folder and see its notes regardless of AI permission.
    const probe = await ctx.app.request(`/api/notes?folderId=${hidden.id}&limit=100`);
    expect(probe.status).toBe(200);
    expect(probe.headers.get('X-Total-Count')).toBe('2');
    const probeRows = (await probe.json()) as unknown[];
    expect(probeRows).toHaveLength(2);
  });

  it('Free tier count uses the raw repo count (no enforcement)', async () => {
    // Pins the short-circuit: on Free the perm engine is inert and count
    // remains authoritative, so restrictive perm rows stored in the DB
    // don't affect behaviour until the user re-activates Pro.
    const hidden = ctx.folders.create('Hidden');
    ctx.notes.create({ body: 'A', folderId: hidden.id, source: 'user' }, 'user');
    ctx.notes.create({ body: 'B', folderId: hidden.id, source: 'user' }, 'user');
    ctx.folders.setMcpPermissions(hidden.id, {
      visible: false,
      create: true,
      update: true,
      delete: true,
    });
    // No activateProHttp — Free.
    const res = await ctx.app.request('/api/notes?limit=100');
    expect(res.headers.get('X-Total-Count')).toBe('2');
  });
});

describe('HTTP /api/notes PATCH', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('moves a note to a folder without bumping updatedAt', async () => {
    const noteRes = await ctx.app.request('/api/notes', json({ body: '# M\n\nunchanged' }));
    expect(noteRes.status).toBe(201);
    const note = (await noteRes.json()) as { id: string; updatedAt: number };

    const folderRes = await ctx.app.request('/api/folders', json({ name: 'Work' }));
    const folder = (await folderRes.json()) as { id: string };

    await new Promise((r) => setTimeout(r, 5));
    const patchRes = await ctx.app.request(
      `/api/notes/${note.id}`,
      patchJson({ folderId: folder.id }),
    );
    expect(patchRes.status).toBe(200);
    const moved = (await patchRes.json()) as {
      folderId: string;
      updatedAt: number;
    };
    expect(moved.folderId).toBe(folder.id);
    expect(moved.updatedAt).toBe(note.updatedAt);
  });

  it('bumps updatedAt on a content edit', async () => {
    const noteRes = await ctx.app.request('/api/notes', json({ body: '# C\n\nv1' }));
    const note = (await noteRes.json()) as { id: string; updatedAt: number };

    await new Promise((r) => setTimeout(r, 5));
    const patchRes = await ctx.app.request(
      `/api/notes/${note.id}`,
      patchJson({ body: 'v2' }),
    );
    const edited = (await patchRes.json()) as { updatedAt: number };
    expect(edited.updatedAt).toBeGreaterThan(note.updatedAt);
  });
});

describe('HTTP /api/notes/trash + restore', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('GET /api/notes/trash returns soft-deleted notes only', async () => {
    const a = (await (
      await ctx.app.request('/api/notes', json({ body: 'A' }))
    ).json()) as { id: string };
    const b = (await (
      await ctx.app.request('/api/notes', json({ body: 'B' }))
    ).json()) as { id: string };

    // Trash A.
    await ctx.app.request(`/api/notes/${a.id}`, { method: 'DELETE' });

    // Live list excludes A.
    const live = (await (await ctx.app.request('/api/notes')).json()) as { id: string }[];
    expect(live.map((n) => n.id)).toEqual([b.id]);

    // Trash list contains exactly A.
    const trash = (await (await ctx.app.request('/api/notes/trash')).json()) as {
      id: string;
      deletedAt: number | null;
    }[];
    expect(trash).toHaveLength(1);
    expect(trash[0].id).toBe(a.id);
    expect(trash[0].deletedAt).not.toBeNull();
  });

  it('POST /api/notes/:id/restore brings a note back into the live list', async () => {
    const note = (await (
      await ctx.app.request('/api/notes', json({ body: '# Lazarus\n\nhi' }))
    ).json()) as { id: string; updatedAt: number };

    await ctx.app.request(`/api/notes/${note.id}`, { method: 'DELETE' });
    const restoreRes = await ctx.app.request(`/api/notes/${note.id}/restore`, { method: 'POST' });
    expect(restoreRes.status).toBe(200);
    const restored = (await restoreRes.json()) as {
      id: string;
      deletedAt: number | null;
      updatedAt: number;
    };
    expect(restored.id).toBe(note.id);
    expect(restored.deletedAt).toBeNull();
    // Restore is metadata: original updatedAt is preserved.
    expect(restored.updatedAt).toBe(note.updatedAt);

    // It is back in the regular list and out of the trash list.
    const live = (await (await ctx.app.request('/api/notes')).json()) as { id: string }[];
    expect(live.map((n) => n.id)).toContain(note.id);
    const trash = (await (await ctx.app.request('/api/notes/trash')).json()) as { id: string }[];
    expect(trash.map((n) => n.id)).not.toContain(note.id);
  });

  it('POST /api/notes/:id/restore returns 404 for unknown ids', async () => {
    const res = await ctx.app.request('/api/notes/does-not-exist/restore', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/notes/:id/purge hard-deletes a trashed note', async () => {
    const note = (await (
      await ctx.app.request('/api/notes', json({ body: 'Doomed' }))
    ).json()) as { id: string };

    // Refuses while live.
    const beforeTrash = await ctx.app.request(`/api/notes/${note.id}/purge`, { method: 'DELETE' });
    expect(beforeTrash.status).toBe(404);

    // Trash, then permanently delete.
    await ctx.app.request(`/api/notes/${note.id}`, { method: 'DELETE' });
    const purgeRes = await ctx.app.request(`/api/notes/${note.id}/purge`, { method: 'DELETE' });
    expect(purgeRes.status).toBe(200);
    expect(((await purgeRes.json()) as { ok: boolean }).ok).toBe(true);

    // Restore is now impossible.
    const restoreRes = await ctx.app.request(`/api/notes/${note.id}/restore`, { method: 'POST' });
    expect(restoreRes.status).toBe(404);

    // Trash list does not contain it.
    const trash = (await (await ctx.app.request('/api/notes/trash')).json()) as { id: string }[];
    expect(trash.map((n) => n.id)).not.toContain(note.id);
  });

  it('DELETE /api/notes/trash empties the trash and leaves live notes alone', async () => {
    const live = (await (
      await ctx.app.request('/api/notes', json({ body: 'Live' }))
    ).json()) as { id: string };
    const a = (await (
      await ctx.app.request('/api/notes', json({ body: 'A' }))
    ).json()) as { id: string };
    const b = (await (
      await ctx.app.request('/api/notes', json({ body: 'B' }))
    ).json()) as { id: string };

    await ctx.app.request(`/api/notes/${a.id}`, { method: 'DELETE' });
    await ctx.app.request(`/api/notes/${b.id}`, { method: 'DELETE' });

    const emptyRes = await ctx.app.request('/api/notes/trash', { method: 'DELETE' });
    expect(emptyRes.status).toBe(200);
    expect(((await emptyRes.json()) as { purged: number }).purged).toBe(2);

    // Trash now empty.
    const trash = (await (await ctx.app.request('/api/notes/trash')).json()) as { id: string }[];
    expect(trash).toEqual([]);

    // Live note untouched.
    const liveList = (await (await ctx.app.request('/api/notes')).json()) as { id: string }[];
    expect(liveList.map((n) => n.id)).toContain(live.id);
  });

  it('GET /api/notes/trash purges entries older than the 7-day window', async () => {
    const fresh = (await (
      await ctx.app.request('/api/notes', json({ body: 'Fresh' }))
    ).json()) as { id: string };
    const stale = (await (
      await ctx.app.request('/api/notes', json({ body: 'Stale' }))
    ).json()) as { id: string };

    await ctx.app.request(`/api/notes/${fresh.id}`, { method: 'DELETE' });
    await ctx.app.request(`/api/notes/${stale.id}`, { method: 'DELETE' });

    // Force the stale one to look older than the 7-day cutoff.
    const ancient = Date.now() - 8 * 24 * 60 * 60 * 1000;
    ctx.handle.db
      .prepare('UPDATE notes SET deleted_at = ? WHERE id = ?')
      .run(ancient, stale.id);

    const trash = (await (await ctx.app.request('/api/notes/trash')).json()) as { id: string }[];
    expect(trash.map((n) => n.id)).toEqual([fresh.id]);

    // The aged-out one is hard-deleted, so even a manual restore returns 404.
    const restoreStale = await ctx.app.request(`/api/notes/${stale.id}/restore`, { method: 'POST' });
    expect(restoreStale.status).toBe(404);
  });
});

describe('HTTP /api/notes/:id/revisions', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  async function createNote(body: Record<string, unknown>): Promise<{ id: string }> {
    const res = await ctx.app.request('/api/notes', json(body));
    return (await res.json()) as { id: string };
  }

  it('lists revisions for a note (empty until something is snapshotted)', async () => {
    const note = await createNote({ body: '# A\n\nb' });
    const res = await ctx.app.request(`/api/notes/${note.id}/revisions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns 404 listing revisions for a missing note', async () => {
    const res = await ctx.app.request('/api/notes/no-such-id/revisions');
    expect(res.status).toBe(404);
  });

  it('snapshots manually via POST and surfaces it in the list', async () => {
    const note = await createNote({ body: '# A\n\nfirst' });
    const create = await ctx.app.request(
      `/api/notes/${note.id}/revisions`,
      { method: 'POST' },
    );
    expect(create.status).toBe(201);
    const rev = (await create.json()) as { id: string; body: string; actor: string };
    expect(rev.body).toBe('# A\n\nfirst');
    expect(rev.actor).toBe('user');

    const list = (await (await ctx.app.request(`/api/notes/${note.id}/revisions`)).json()) as Array<{
      id: string;
    }>;
    expect(list.map((r) => r.id)).toEqual([rev.id]);
  });

  it('refuses to snapshot a trashed note', async () => {
    const note = await createNote({ body: '# A\n\nb' });
    await ctx.app.request(`/api/notes/${note.id}`, { method: 'DELETE' });
    const res = await ctx.app.request(`/api/notes/${note.id}/revisions`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('restores an old revision and snapshots current state first (undoable)', async () => {
    const note = await createNote({ body: '# A\n\noriginal' });
    // Snapshot original.
    const snap = await ctx.app.request(`/api/notes/${note.id}/revisions`, { method: 'POST' });
    const original = (await snap.json()) as { id: string };
    // Edit the live note.
    await ctx.app.request(`/api/notes/${note.id}`, patchJson({ body: 'edited' }));

    // Restore the original revision.
    const restore = await ctx.app.request(
      `/api/notes/${note.id}/revisions/${original.id}/restore`,
      { method: 'POST' },
    );
    expect(restore.status).toBe(200);
    const restored = (await restore.json()) as { body: string };
    expect(restored.body).toBe('# A\n\noriginal');

    // Restore should have captured a backup of the "edited" state, so the
    // history now has at least two rows: the original snapshot and the
    // pre-restore backup.
    const list = (await (await ctx.app.request(`/api/notes/${note.id}/revisions`)).json()) as Array<{
      body: string;
    }>;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some((r) => r.body === 'edited')).toBe(true);
  });

  it('returns 404 when restoring a revision that does not belong to the note', async () => {
    const noteA = await createNote({ body: '# A\n\na' });
    const noteB = await createNote({ body: '# B\n\nb' });
    const snap = await ctx.app.request(`/api/notes/${noteA.id}/revisions`, { method: 'POST' });
    const rev = (await snap.json()) as { id: string };
    // Wrong parent id.
    const res = await ctx.app.request(
      `/api/notes/${noteB.id}/revisions/${rev.id}/restore`,
      { method: 'POST' },
    );
    expect(res.status).toBe(404);
  });

  it('restores into the original folder when it still exists', async () => {
    const folderRes = await ctx.app.request('/api/folders', json({ name: 'Work' }));
    const folder = (await folderRes.json()) as { id: string };
    const note = await createNote({ body: '# A\n\nb', folderId: folder.id });
    const snap = await ctx.app.request(`/api/notes/${note.id}/revisions`, { method: 'POST' });
    const rev = (await snap.json()) as { id: string };

    // Move out of the folder, then restore — folderId should come back.
    await ctx.app.request(`/api/notes/${note.id}`, patchJson({ folderId: null }));
    const restored = (await (
      await ctx.app.request(`/api/notes/${note.id}/revisions/${rev.id}/restore`, { method: 'POST' })
    ).json()) as { folderId: string | null };
    expect(restored.folderId).toBe(folder.id);
  });

  it('drops a missing folder reference when restoring', async () => {
    const folderRes = await ctx.app.request('/api/folders', json({ name: 'Temp' }));
    const folder = (await folderRes.json()) as { id: string };
    const note = await createNote({ body: '# A\n\nb', folderId: folder.id });
    const snap = await ctx.app.request(`/api/notes/${note.id}/revisions`, { method: 'POST' });
    const rev = (await snap.json()) as { id: string };

    // Delete the folder + move the note out so the historical folder id no
    // longer resolves.
    await ctx.app.request(`/api/notes/${note.id}`, patchJson({ folderId: null }));
    await ctx.app.request(`/api/folders/${folder.id}`, { method: 'DELETE' });

    const restored = (await (
      await ctx.app.request(`/api/notes/${note.id}/revisions/${rev.id}/restore`, { method: 'POST' })
    ).json()) as { folderId: string | null };
    expect(restored.folderId).toBeNull();
  });
});

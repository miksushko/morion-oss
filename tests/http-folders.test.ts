import { beforeEach, describe, expect, it } from 'vitest';

import { type Ctx, setup, json } from './http/helpers.js';

describe('HTTP /api/folders', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('returns folders with noteCount', async () => {
    const create = await ctx.app.request('/api/folders', json({ name: 'Work' }));
    expect(create.status).toBe(201);
    const folder = (await create.json()) as { id: string };

    await ctx.app.request('/api/notes', json({ body: 'N1', folderId: folder.id }));
    await ctx.app.request('/api/notes', json({ body: 'N2', folderId: folder.id }));

    const list = await ctx.app.request('/api/folders');
    const folders = (await list.json()) as { name: string; noteCount: number }[];
    const work = folders.find((f) => f.name === 'Work');
    expect(work?.noteCount).toBe(2);
  });

  it('duplicates a folder + its notes via POST /:id/duplicate', async () => {
    const work = (await (
      await ctx.app.request('/api/folders', json({ name: 'Work' }))
    ).json()) as { id: string };
    await ctx.app.request('/api/notes', json({ body: '# A\n\na body', folderId: work.id }));
    await ctx.app.request('/api/notes', json({ body: '# B\n\nb body', folderId: work.id }));

    const dup = await ctx.app.request(`/api/folders/${work.id}/duplicate`, { method: 'POST' });
    expect(dup.status).toBe(201);
    const copy = (await dup.json()) as { id: string; name: string; noteCount: number };
    expect(copy.name).toBe('Work (Copy)');
    expect(copy.noteCount).toBe(2);
    expect(copy.id).not.toBe(work.id);

    // Sidebar order: Work then Work (Copy).
    const list = (await (await ctx.app.request('/api/folders')).json()) as {
      id: string;
      name: string;
    }[];
    const names = list.map((f) => f.name);
    expect(names.indexOf('Work (Copy)')).toBe(names.indexOf('Work') + 1);
  });

  it('returns 404 when duplicating a missing folder', async () => {
    const dup = await ctx.app.request('/api/folders/does-not-exist/duplicate', { method: 'POST' });
    expect(dup.status).toBe(404);
  });

  it('moves a folder one slot up/down via POST /:id/move', async () => {
    const a = (await (await ctx.app.request('/api/folders', json({ name: 'A' }))).json()) as {
      id: string;
    };
    const b = (await (await ctx.app.request('/api/folders', json({ name: 'B' }))).json()) as {
      id: string;
    };
    await ctx.app.request('/api/folders', json({ name: 'C' }));

    const up = await ctx.app.request(`/api/folders/${b.id}/move`, json({ direction: 'up' }));
    expect(up.status).toBe(200);
    const after = (await up.json()) as { name: string }[];
    expect(after.map((f) => f.name)).toEqual(['B', 'A', 'C']);

    // Boundary: A at index 1 can't go down? It can — only the topmost cannot
    // go up and the bottommost cannot go down. After [B,A,C]: A can go up,
    // C cannot go down.
    const cantDown = await ctx.app.request(
      `/api/folders/${a.id}/move`,
      json({ direction: 'up' }),
    );
    expect(cantDown.status).toBe(200);
  });

  // Ticket 01KQFDZB7C61F5EMKQEKYPP3YA
  describe('DELETE /api/folders/:id with optional purgeNotes', () => {
    it('default (no purgeNotes) unfiles notes — they survive at root', async () => {
      const work = (await (
        await ctx.app.request('/api/folders', json({ name: 'Work' }))
      ).json()) as { id: string };
      const n1 = (await (
        await ctx.app.request('/api/notes', json({ body: 'survivor', folderId: work.id }))
      ).json()) as { id: string };

      const del = await ctx.app.request(`/api/folders/${work.id}`, {
        method: 'DELETE',
      });
      expect(del.status).toBe(200);
      const body = (await del.json()) as { ok: boolean; deletedNoteCount: number };
      expect(body.ok).toBe(true);
      expect(body.deletedNoteCount).toBe(0);

      // Note still exists, no folder, not deleted.
      const noteRes = await ctx.app.request(`/api/notes/${n1.id}`);
      expect(noteRes.status).toBe(200);
      const note = (await noteRes.json()) as { folderId: string | null; deletedAt: number | null };
      expect(note.folderId).toBeNull();
      expect(note.deletedAt).toBeNull();
    });

    it('purgeNotes=true soft-deletes notes (folderId stays for trash restore context)', async () => {
      const work = (await (
        await ctx.app.request('/api/folders', json({ name: 'Work' }))
      ).json()) as { id: string };
      const n1 = (await (
        await ctx.app.request('/api/notes', json({ body: 'doomed-1', folderId: work.id }))
      ).json()) as { id: string };
      const n2 = (await (
        await ctx.app.request('/api/notes', json({ body: 'doomed-2', folderId: work.id }))
      ).json()) as { id: string };

      const del = await ctx.app.request(
        `/api/folders/${work.id}?purgeNotes=true`,
        { method: 'DELETE' },
      );
      expect(del.status).toBe(200);
      const body = (await del.json()) as { ok: boolean; deletedNoteCount: number };
      expect(body.ok).toBe(true);
      expect(body.deletedNoteCount).toBe(2);

      // Notes are soft-deleted: GET returns 404 (deleted_at filter).
      const r1 = await ctx.app.request(`/api/notes/${n1.id}`);
      expect(r1.status).toBe(404);
      const r2 = await ctx.app.request(`/api/notes/${n2.id}`);
      expect(r2.status).toBe(404);

      // But they show up in trash list (restorable).
      const trash = (await (
        await ctx.app.request('/api/notes/trash')
      ).json()) as Array<{ id: string }>;
      const trashIds = trash.map((t) => t.id);
      expect(trashIds).toContain(n1.id);
      expect(trashIds).toContain(n2.id);
    });

    it('purgeNotes=true on empty folder returns deletedNoteCount=0', async () => {
      const empty = (await (
        await ctx.app.request('/api/folders', json({ name: 'Empty' }))
      ).json()) as { id: string };
      const del = await ctx.app.request(
        `/api/folders/${empty.id}?purgeNotes=true`,
        { method: 'DELETE' },
      );
      expect(del.status).toBe(200);
      const body = (await del.json()) as { deletedNoteCount: number };
      expect(body.deletedNoteCount).toBe(0);
    });

    it('downloadable skill bundle endpoints serve manifest + ZIP + individual files', async () => {
      // Ticket 01KQFF7EE7VS0R7AA9B9WAH3RQ — make the skill installable
      // for non-Claude agents (and for dev/web users who don't have
      // the Tauri shell IPC).
      const m = await ctx.app.request('/api/skills/morion/manifest');
      expect(m.status).toBe(200);
      const manifest = (await m.json()) as {
        name: string;
        version: string | null;
        files: Array<{ path: string; size: number }>;
        totalSize: number;
      };
      expect(manifest.name).toBe('morion');
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(manifest.files.find((f) => f.path === 'SKILL.md')).toBeDefined();
      expect(manifest.totalSize).toBeGreaterThan(1000);

      const f = await ctx.app.request('/api/skills/morion/file?path=SKILL.md');
      expect(f.status).toBe(200);
      expect(f.headers.get('Content-Type')).toContain('text/markdown');
      const skillBody = await f.text();
      expect(skillBody).toMatch(/^---/); // frontmatter

      const z = await ctx.app.request('/api/skills/morion/bundle.zip');
      expect(z.status).toBe(200);
      expect(z.headers.get('Content-Type')).toBe('application/zip');
      const zipBuf = Buffer.from(await z.arrayBuffer());
      // ZIP local file header magic = PK\x03\x04
      expect(zipBuf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      // End-of-central-directory marker should appear near the end.
      const eocdOffset = zipBuf.lastIndexOf(
        Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      );
      expect(eocdOffset).toBeGreaterThan(0);
    });

    it('skill file endpoint rejects path-traversal attempts (allowlist gate)', async () => {
      const r = await ctx.app.request(
        '/api/skills/morion/file?path=../../../../etc/passwd',
      );
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string };
      expect(body.error).toBe('invalid_path');
    });

    it('mo:* system notes are hard-deleted with the folder, NOT trashed (regardless of purgeNotes flag)', async () => {
      const work = (await (
        await ctx.app.request('/api/folders', json({ name: 'WorkMo' }))
      ).json()) as { id: string };
      // Real user note + a Mo-maintained system note. Direct repo
      // create for the mo:* note since the public API doesn't
      // expose `source` on POST.
      const userNote = (await (
        await ctx.app.request('/api/notes', json({ body: 'real', folderId: work.id }))
      ).json()) as { id: string };
      const moNoteId = ctx.notes.create(
        { body: '# mo:cluster:foo\n\nauto stuff', folderId: work.id, source: 'mo:cluster:foo' },
        'mcp:morion-concierge',
      ).id;

      // Default purge-only-checkbox flow: mo:* MUST still be hard-deleted.
      const del = await ctx.app.request(`/api/folders/${work.id}`, {
        method: 'DELETE',
      });
      expect(del.status).toBe(200);

      // mo:* note is GONE (not in trash, not anywhere).
      const trash = (await (await ctx.app.request('/api/notes/trash')).json()) as Array<{ id: string }>;
      expect(trash.map((t) => t.id)).not.toContain(moNoteId);
      const moRow = ctx.notes.getById(moNoteId);
      expect(moRow).toBeNull();
      // Regular user note survived unfiled (no purgeNotes flag).
      const userAlive = ctx.notes.getById(userNote.id);
      expect(userAlive?.folderId).toBeNull();
      expect(userAlive?.deletedAt).toBeNull();
    });
  });
});

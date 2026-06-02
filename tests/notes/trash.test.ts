import { describe, it, expect, beforeEach } from 'vitest';
import { FtsIndex } from '../../src/core/search/fts.js';
import { setupNotesRepoCtx, type NotesRepoCtx } from '../helpers/notes-repo-setup.js';

describe('NotesRepository — soft-delete + restore + retention', () => {
  let ctx: NotesRepoCtx;

  beforeEach(() => {
    ctx = setupNotesRepoCtx();
  });

  it('soft-deletes a note', () => {
    const note = ctx.notes.create({ body: 'Bye', source: 'user' }, 'user');
    expect(ctx.notes.delete(note.id, 'user')).toBe(true);
    expect(ctx.notes.getById(note.id)).toBeNull();

    expect(ctx.notes.delete(note.id, 'user')).toBe(false);
  });

  it('soft-delete leaves updated_at alone (so restore lands at original position)', async () => {
    // Apple Notes parity: trashing a note from two weeks ago should not bump
    // it to the top of the list when restored. Soft-delete is metadata.
    const note = ctx.notes.create({ body: '# Old\n\nunchanged', source: 'user' }, 'user');
    await new Promise((r) => setTimeout(r, 5));
    ctx.notes.delete(note.id, 'user');
    const restored = ctx.notes.restore(note.id, 'user');
    expect(restored?.updatedAt).toBe(note.updatedAt);
  });

  it('listTrashed returns soft-deleted notes inside the window, sorted newest first', async () => {
    const a = ctx.notes.create({ body: 'A', source: 'user' }, 'user');
    const b = ctx.notes.create({ body: 'B', source: 'user' }, 'user');
    const c = ctx.notes.create({ body: 'C', source: 'user' }, 'user');

    ctx.notes.delete(a.id, 'user');
    await new Promise((r) => setTimeout(r, 5));
    ctx.notes.delete(b.id, 'user');
    // c stays alive

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const trashed = ctx.notes.listTrashed(cutoff);
    expect(trashed.map((n) => n.title)).toEqual(['B', 'A']);
    expect(trashed.every((n) => n.deletedAt !== null)).toBe(true);
    expect(c.id).toBeTruthy();
  });

  it('listTrashed excludes notes whose deleted_at is older than the cutoff', () => {
    const note = ctx.notes.create({ body: 'Ancient', source: 'user' }, 'user');
    ctx.notes.delete(note.id, 'user');
    const ancient = Date.now() - 14 * 24 * 60 * 60 * 1000;
    ctx.handle.db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(ancient, note.id);

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(ctx.notes.listTrashed(cutoff)).toEqual([]);
  });

  it('restore brings a soft-deleted note back without bumping updated_at', async () => {
    const note = ctx.notes.create({ body: '# Lazarus\n\nhi', source: 'user' }, 'user');
    await new Promise((r) => setTimeout(r, 5));
    ctx.notes.delete(note.id, 'user');

    const restored = ctx.notes.restore(note.id, 'user');
    expect(restored).not.toBeNull();
    expect(restored!.deletedAt).toBeNull();
    expect(restored!.updatedAt).toBe(note.updatedAt);
    expect(ctx.notes.getById(note.id)?.id).toBe(note.id);

    const all = ctx.notes.list({ limit: 50, offset: 0 });
    expect(all.map((n) => n.id)).toContain(note.id);
  });

  it('restore returns null for unknown ids and for live notes', () => {
    expect(ctx.notes.restore('does-not-exist', 'user')).toBeNull();
    const live = ctx.notes.create({ body: 'Alive', source: 'user' }, 'user');
    expect(ctx.notes.restore(live.id, 'user')).toBeNull();
  });

  // H8 regression guard (lessons.md 2026-04-14): `restore` relies on the
  // `notes_au` FTS5 trigger firing on UPDATE to re-insert the row. If the
  // trigger is ever removed or changed to ignore deleted_at flips, soft-
  // deleted + restored notes would silently drop out of keyword search.
  it('restore re-adds a soft-deleted note to FTS so search finds it again', () => {
    const fts = new FtsIndex(ctx.handle.db);
    const n = ctx.notes.create(
      { body: 'unique-marker-xyz\n\nbody text', source: 'user' },
      'user',
    );
    expect(fts.search('unique-marker-xyz', 10).map((r) => r.noteId)).toContain(n.id);

    ctx.notes.delete(n.id, 'user');
    expect(fts.search('unique-marker-xyz', 10).map((r) => r.noteId)).not.toContain(n.id);

    ctx.notes.restore(n.id, 'user');
    expect(fts.search('unique-marker-xyz', 10).map((r) => r.noteId)).toContain(n.id);
  });

  it('purgeOlderThan hard-deletes aged-out trash and returns the ids', () => {
    const fresh = ctx.notes.create({ body: 'Fresh', source: 'user' }, 'user');
    const stale = ctx.notes.create({ body: 'Stale', source: 'user' }, 'user');
    ctx.notes.delete(fresh.id, 'user');
    ctx.notes.delete(stale.id, 'user');

    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    ctx.handle.db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(cutoff - 1000, stale.id);

    const purged = ctx.notes.purgeOlderThan(cutoff);
    expect(purged).toEqual([stale.id]);

    expect(ctx.notes.getById(stale.id, { includeTrashed: true })).toBeNull();
    expect(ctx.notes.getById(fresh.id, { includeTrashed: true })?.id).toBe(fresh.id);
  });

  it('purge hard-deletes a single trashed note and refuses live ones', () => {
    const live = ctx.notes.create({ body: 'Live', source: 'user' }, 'user');
    const trashed = ctx.notes.create({ body: 'Trashed', source: 'user' }, 'user');
    ctx.notes.delete(trashed.id, 'user');

    expect(ctx.notes.purge(live.id, 'user')).toBe(false);
    expect(ctx.notes.getById(live.id)?.id).toBe(live.id);

    expect(ctx.notes.purge(trashed.id, 'user')).toBe(true);
    expect(ctx.notes.getById(trashed.id, { includeTrashed: true })).toBeNull();

    expect(ctx.notes.purge(trashed.id, 'user')).toBe(false);
  });

  it('purgeAllTrashed empties the trash regardless of age and leaves live notes alone', () => {
    const live = ctx.notes.create({ body: 'Live', source: 'user' }, 'user');
    const fresh = ctx.notes.create({ body: 'Fresh', source: 'user' }, 'user');
    const stale = ctx.notes.create({ body: 'Stale', source: 'user' }, 'user');
    ctx.notes.delete(fresh.id, 'user');
    ctx.notes.delete(stale.id, 'user');
    ctx.handle.db
      .prepare('UPDATE notes SET deleted_at = ? WHERE id = ?')
      .run(Date.now() - 30 * 24 * 60 * 60 * 1000, stale.id);

    const purged = ctx.notes.purgeAllTrashed();
    expect(purged.sort()).toEqual([fresh.id, stale.id].sort());

    expect(ctx.notes.getById(fresh.id, { includeTrashed: true })).toBeNull();
    expect(ctx.notes.getById(stale.id, { includeTrashed: true })).toBeNull();
    expect(ctx.notes.getById(live.id)?.id).toBe(live.id);

    expect(ctx.notes.purgeAllTrashed()).toEqual([]);
  });
});

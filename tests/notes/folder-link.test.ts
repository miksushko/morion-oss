import { describe, it, expect, beforeEach } from 'vitest';
import { duplicateFolder } from '../../src/core/folders/duplicate.js';
import { setupNotesRepoCtx, type NotesRepoCtx } from '../helpers/notes-repo-setup.js';

describe('FoldersRepository + notes folder-link', () => {
  let ctx: NotesRepoCtx;

  beforeEach(() => {
    ctx = setupNotesRepoCtx();
  });

  it('exposes folders.list and folders CRUD', () => {
    const a = ctx.folders.create('A');
    ctx.folders.create('B');
    expect(ctx.folders.list()).toHaveLength(2);
    expect(ctx.folders.rename(a.id, 'A2')).toBe(true);
    expect(ctx.folders.getById(a.id)?.name).toBe('A2');
    expect(ctx.folders.delete(a.id)).toBe(true);
    expect(ctx.folders.list()).toHaveLength(1);
  });

  it('moves a folder one slot up or down within its parent ordering', () => {
    const a = ctx.folders.create('A');
    const b = ctx.folders.create('B');
    const c = ctx.folders.create('C');

    expect(ctx.folders.list().map((f) => f.name)).toEqual(['A', 'B', 'C']);

    expect(ctx.folders.move(b.id, -1)).toBe(true);
    expect(ctx.folders.list().map((f) => f.name)).toEqual(['B', 'A', 'C']);

    expect(ctx.folders.move(b.id, 1)).toBe(true);
    expect(ctx.folders.list().map((f) => f.name)).toEqual(['A', 'B', 'C']);

    expect(ctx.folders.move(a.id, -1)).toBe(false);
    expect(ctx.folders.list().map((f) => f.name)).toEqual(['A', 'B', 'C']);

    expect(ctx.folders.move(c.id, 1)).toBe(false);

    expect(ctx.folders.move('does-not-exist', 1)).toBe(false);
  });

  it('duplicateShell clones an empty folder right after the source', () => {
    const a = ctx.folders.create('A');
    ctx.folders.create('B');
    ctx.folders.create('C');
    expect(ctx.folders.list().map((f) => f.name)).toEqual(['A', 'B', 'C']);

    const copy = ctx.folders.duplicateShell(a.id);
    expect(copy?.name).toBe('A (Copy)');
    expect(ctx.folders.list().map((f) => f.name)).toEqual(['A', 'A (Copy)', 'B', 'C']);
  });

  it('duplicateFolder deep-copies notes (new ids, fresh timestamps, original untouched)', async () => {
    const work = ctx.folders.create('Work');
    const original = ctx.notes.create(
      {
        body: '# Plan\n\nTBD',
        folderId: work.id,
        source: 'user',
        tags: ['urgent', 'q2'],
        pinned: true,
      },
      'user',
    );

    await new Promise((r) => setTimeout(r, 5));

    const result = duplicateFolder(ctx.folders, ctx.notes, work.id, 'user');
    expect(result).not.toBeNull();
    expect(result!.folder.name).toBe('Work (Copy)');
    expect(result!.folder.noteCount).toBe(1);
    expect(result!.newNoteIds).toHaveLength(1);

    const originalFresh = ctx.notes.getById(original.id)!;
    expect(originalFresh.folderId).toBe(work.id);
    expect(originalFresh.title).toBe('Plan');

    const copy = ctx.notes.getById(result!.newNoteIds[0]!)!;
    expect(copy.id).not.toBe(original.id);
    expect(copy.folderId).toBe(result!.folder.id);
    expect(copy.title).toBe('Plan');
    expect(copy.body).toBe('# Plan\n\nTBD');
    expect(copy.tags.sort()).toEqual(['q2', 'urgent']);
    expect(copy.pinned).toBe(true);
    expect(copy.createdAt).toBeGreaterThan(original.createdAt);

    expect(ctx.tags.list().filter((t) => t.name === 'urgent')).toHaveLength(1);
  });

  it('duplicateFolder returns null for a missing folder', () => {
    expect(duplicateFolder(ctx.folders, ctx.notes, 'does-not-exist', 'user')).toBeNull();
  });

  it('reorders folders by id list and unfiles notes when a folder is deleted', () => {
    const a = ctx.folders.create('A');
    const b = ctx.folders.create('B');
    const c = ctx.folders.create('C');

    ctx.folders.reorder([c.id, a.id, b.id]);
    expect(ctx.folders.list().map((f) => f.name)).toEqual(['C', 'A', 'B']);

    const note = ctx.notes.create(
      { body: 'in A', folderId: a.id, source: 'user' },
      'user',
    );
    ctx.folders.delete(a.id);
    const fetched = ctx.notes.getById(note.id);
    expect(fetched?.folderId).toBeNull();
    expect(b.id).toBeTruthy();
  });

  it('exposes noteCount on folders.list (LEFT JOIN, soft-deletes excluded)', () => {
    const work = ctx.folders.create('Work');
    const empty = ctx.folders.create('Empty');
    const a = ctx.notes.create(
      { body: 'A', folderId: work.id, source: 'user' },
      'user',
    );
    ctx.notes.create({ body: 'B', folderId: work.id, source: 'user' }, 'user');
    ctx.notes.delete(a.id, 'user');

    const list = ctx.folders.list();
    const byName = Object.fromEntries(list.map((f) => [f.name, f]));
    expect(byName.Work.noteCount).toBe(1);
    expect(byName.Empty.noteCount).toBe(0);
    expect(empty.id).toBeTruthy();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { setupNotesRepoCtx, type NotesRepoCtx } from '../helpers/notes-repo-setup.js';

describe('NotesRepository — CRUD + updated_at invariants', () => {
  let ctx: NotesRepoCtx;

  beforeEach(() => {
    ctx = setupNotesRepoCtx();
  });

  it('creates and reads a note (title derived from first line of body)', () => {
    const created = ctx.notes.create(
      { body: '# Hello\n\nSome content here', source: 'user' },
      'user',
    );
    expect(created.id).toBeTruthy();
    expect(created.title).toBe('Hello');
    expect(created.body).toBe('# Hello\n\nSome content here');
    expect(created.tags).toEqual([]);
    expect(created.pinned).toBe(false);

    const fetched = ctx.notes.getById(created.id);
    expect(fetched).toEqual(created);
  });

  it('creates a note via legacy title field (merges title into body)', () => {
    const created = ctx.notes.create(
      { title: 'Legacy Title', body: 'body text', source: 'user' },
      'user',
    );
    expect(created.title).toBe('Legacy Title');
    expect(created.body).toBe('# Legacy Title\n\nbody text');
  });

  it('creates a note with tags and folder', () => {
    const folder = ctx.folders.create('Work');
    const note = ctx.notes.create(
      {
        body: '# Project plan\n\nTBD',
        folderId: folder.id,
        tags: ['planning', 'q2'],
        source: 'user',
      },
      'user',
    );
    expect(note.folderId).toBe(folder.id);
    expect(note.title).toBe('Project plan');
    expect(note.tags).toEqual(['planning', 'q2']);

    expect(ctx.tags.findByName('planning')).not.toBeNull();
    expect(ctx.tags.findByName('q2')).not.toBeNull();
  });

  it('updates a note partially', () => {
    const note = ctx.notes.create({ body: 'Draft', source: 'user' }, 'user');
    const updated = ctx.notes.update(note.id, { body: '# Final\n\ncontent', pinned: true }, 'user');
    expect(updated?.title).toBe('Final');
    expect(updated?.pinned).toBe(true);
    expect(updated?.body).toBe('# Final\n\ncontent');
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(note.updatedAt);
  });

  it('replaces tag set on update', () => {
    const note = ctx.notes.create(
      { body: 'T', source: 'user', tags: ['a', 'b'] },
      'user',
    );
    const updated = ctx.notes.update(note.id, { tags: ['c'] }, 'user');
    expect(updated?.tags).toEqual(['c']);
  });

  it('does not bump updated_at on metadata-only changes (folder, pin, tags)', async () => {
    // Apple Notes parity: a drag-to-folder must not show as a content edit,
    // because then the moved note jumps to the top of the destination list.
    const note = ctx.notes.create({ body: '# M\n\nunchanged', source: 'user' }, 'user');
    const work = ctx.folders.create('Work');
    await new Promise((r) => setTimeout(r, 5));

    const moved = ctx.notes.update(note.id, { folderId: work.id }, 'user');
    expect(moved?.folderId).toBe(work.id);
    expect(moved?.updatedAt).toBe(note.updatedAt);

    await new Promise((r) => setTimeout(r, 5));
    const pinned = ctx.notes.update(note.id, { pinned: true }, 'user');
    expect(pinned?.pinned).toBe(true);
    expect(pinned?.updatedAt).toBe(note.updatedAt);

    await new Promise((r) => setTimeout(r, 5));
    const tagged = ctx.notes.update(note.id, { tags: ['urgent'] }, 'user');
    expect(tagged?.tags).toEqual(['urgent']);
    expect(tagged?.updatedAt).toBe(note.updatedAt);

    // A real content edit still bumps.
    await new Promise((r) => setTimeout(r, 5));
    const edited = ctx.notes.update(note.id, { body: '# M\n\nchanged' }, 'user');
    expect(edited?.updatedAt).toBeGreaterThan(note.updatedAt);
  });

  it('does not bump updated_at when body patch value equals current row', async () => {
    // Regression: the web editor's Tiptap wrapper round-trips the body through
    // onChange when switching notes, so simply clicking a note PATCHed it with
    // body=<unchanged>. The repo must treat that as a no-op.
    const note = ctx.notes.create(
      { body: '# Same\n\nsame body', source: 'user' },
      'user',
    );
    await new Promise((r) => setTimeout(r, 5));

    const a = ctx.notes.update(note.id, { body: '# Same\n\nsame body' }, 'user');
    expect(a?.updatedAt).toBe(note.updatedAt);
  });
});

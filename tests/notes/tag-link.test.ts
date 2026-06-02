import { describe, it, expect, beforeEach } from 'vitest';
import { setupNotesRepoCtx, type NotesRepoCtx } from '../helpers/notes-repo-setup.js';

describe('TagsRepository + notes tag-link', () => {
  let ctx: NotesRepoCtx;

  beforeEach(() => {
    ctx = setupNotesRepoCtx();
  });

  it('upserts tags by name without duplicates', () => {
    const t1 = ctx.tags.upsertByName('foo');
    const t2 = ctx.tags.upsertByName('foo');
    expect(t1.id).toBe(t2.id);
    expect(ctx.tags.list()).toHaveLength(1);
  });

  it('exposes noteCount on tags.list (CASCADE-aware, soft-deletes excluded)', () => {
    const a = ctx.notes.create(
      { body: 'A', source: 'user', tags: ['urgent', 'work'] },
      'user',
    );
    ctx.notes.create({ body: 'B', source: 'user', tags: ['urgent'] }, 'user');
    ctx.tags.create('orphan', '#abcdef');
    ctx.notes.delete(a.id, 'user');

    const byName = Object.fromEntries(ctx.tags.list().map((t) => [t.name, t]));
    expect(byName.urgent.noteCount).toBe(1);
    expect(byName.work.noteCount).toBe(0);
    expect(byName.orphan.noteCount).toBe(0);
    expect(byName.orphan.color).toBe('#abcdef');
  });

  it('creates, updates, and deletes tags with explicit color', () => {
    const created = ctx.tags.create('priority', '#ff0000');
    expect(created.name).toBe('priority');
    expect(created.color).toBe('#ff0000');
    expect(created.noteCount).toBe(0);

    const renamed = ctx.tags.update(created.id, { name: 'high', color: '#00ff00' });
    expect(renamed?.name).toBe('high');
    expect(renamed?.color).toBe('#00ff00');

    // Partial update — only color, name stays.
    const recolored = ctx.tags.update(created.id, { color: null });
    expect(recolored?.name).toBe('high');
    expect(recolored?.color).toBeNull();

    expect(ctx.tags.update('does-not-exist', { name: 'x' })).toBeNull();
    expect(ctx.tags.delete(created.id)).toBe(true);
    expect(ctx.tags.delete(created.id)).toBe(false);
  });

  it('cascades note_tags rows when a tag is deleted, leaving notes intact', () => {
    const note = ctx.notes.create(
      { body: 'A', source: 'user', tags: ['keep', 'doomed'] },
      'user',
    );
    const doomed = ctx.tags.findByName('doomed');
    expect(doomed).not.toBeNull();
    expect(ctx.tags.delete(doomed!.id)).toBe(true);

    const fetched = ctx.notes.getById(note.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.tags).toEqual(['keep']);
  });
});

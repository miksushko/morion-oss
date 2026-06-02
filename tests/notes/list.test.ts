import { describe, it, expect, beforeEach } from 'vitest';
import { setupNotesRepoCtx, type NotesRepoCtx } from '../helpers/notes-repo-setup.js';

describe('NotesRepository — list + count + ordering', () => {
  let ctx: NotesRepoCtx;

  beforeEach(() => {
    ctx = setupNotesRepoCtx();
  });

  it('lists notes with folder filter', () => {
    const work = ctx.folders.create('Work');
    const personal = ctx.folders.create('Personal');
    ctx.notes.create({ body: 'A', folderId: work.id, source: 'user' }, 'user');
    ctx.notes.create({ body: 'B', folderId: work.id, source: 'user' }, 'user');
    ctx.notes.create({ body: 'C', folderId: personal.id, source: 'user' }, 'user');

    const workNotes = ctx.notes.list({ folderId: work.id, limit: 50, offset: 0 });
    expect(workNotes).toHaveLength(2);
    expect(workNotes.map((n) => n.title).sort()).toEqual(['A', 'B']);
  });

  it('lists notes with tag filter', () => {
    ctx.notes.create({ body: 'A', source: 'user', tags: ['urgent'] }, 'user');
    ctx.notes.create({ body: 'B', source: 'user', tags: ['urgent', 'work'] }, 'user');
    ctx.notes.create({ body: 'C', source: 'user', tags: ['work'] }, 'user');

    const urgent = ctx.notes.list({ tag: 'urgent', limit: 50, offset: 0 });
    expect(urgent.map((n) => n.title).sort()).toEqual(['A', 'B']);
  });

  it('count() matches the filtered-list size regardless of limit/offset', () => {
    // Regression for the UI pagination hint: the "N of M" badge reads M from
    // this method, so it must mirror the exact same filters as list() minus
    // the paging controls. A drift between the two SQL builders would break
    // infinite-scroll by never reaching "loaded === total".
    const work = ctx.folders.create('Work');
    const personal = ctx.folders.create('Personal');
    for (let i = 0; i < 7; i++) {
      ctx.notes.create(
        { body: `W${i}`, folderId: work.id, source: 'user', tags: ['urgent'] },
        'user',
      );
    }
    for (let i = 0; i < 3; i++) {
      ctx.notes.create(
        { body: `P${i}`, folderId: personal.id, source: 'user' },
        'user',
      );
    }

    expect(ctx.notes.count({})).toBe(10);
    expect(ctx.notes.list({ limit: 5, offset: 0 })).toHaveLength(5);

    expect(ctx.notes.count({ folderId: work.id })).toBe(7);
    expect(ctx.notes.list({ folderId: work.id, limit: 2, offset: 0 })).toHaveLength(2);

    expect(ctx.notes.count({ tag: 'urgent' })).toBe(7);

    const all = ctx.notes.list({ limit: 100, offset: 0 });
    ctx.notes.delete(all[0].id, 'user');
    expect(ctx.notes.count({})).toBe(9);
  });

  it('orders pinned notes first then by updated_at desc', () => {
    const a = ctx.notes.create({ body: 'A', source: 'user' }, 'user');
    const b = ctx.notes.create({ body: 'B', source: 'user' }, 'user');
    ctx.notes.create({ body: 'C', source: 'user' }, 'user');
    ctx.notes.update(a.id, { pinned: true }, 'user');
    ctx.notes.update(b.id, { body: '# B\n\nupdated' }, 'user');

    const list = ctx.notes.list({ limit: 50, offset: 0 });
    expect(list[0].title).toBe('A');
    expect(list[1].title).toBe('B');
  });
});

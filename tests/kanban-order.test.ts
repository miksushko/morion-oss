import { describe, it, expect } from 'vitest';
import {
  orderKanbanCards,
  bucketKanbanCards,
  kanbanCardNeighbours,
} from '../src/web/src/lib/kanbanOrder';
import type { Note, NoteStatus } from '../src/web/src/lib/api';

function makeNote(partial: Partial<Note> & { id: string; status: NoteStatus }): Note {
  return {
    id: partial.id,
    folderId: partial.folderId ?? 'f1',
    title: partial.title ?? partial.id,
    body: partial.body ?? '',
    pinned: false,
    source: 'user',
    createdAt: partial.createdAt ?? 0,
    updatedAt: partial.updatedAt ?? 0,
    deletedAt: null,
    archivedAt: null,
    status: partial.status,
    position: partial.position ?? null,
    tags: [],
    mcpPermissions: { visible: null, update: null, delete: null },
  };
}

describe('orderKanbanCards', () => {
  it('groups by status in column order: note → backlog → todo → doing → review → done', () => {
    const notes = [
      makeNote({ id: 'd', status: 'done', position: 0 }),
      makeNote({ id: 'n', status: 'note', updatedAt: 10 }),
      makeNote({ id: 't', status: 'todo', position: 0 }),
      makeNote({ id: 'b', status: 'backlog', position: 0 }),
      makeNote({ id: 'do', status: 'doing', position: 0 }),
      makeNote({ id: 'r', status: 'review', position: 0 }),
    ];
    expect(orderKanbanCards(notes).map((n) => n.id)).toEqual([
      'n', 'b', 't', 'do', 'r', 'd',
    ]);
  });

  it('sorts the note column by updatedAt DESC', () => {
    const notes = [
      makeNote({ id: 'old', status: 'note', updatedAt: 100 }),
      makeNote({ id: 'new', status: 'note', updatedAt: 300 }),
      makeNote({ id: 'mid', status: 'note', updatedAt: 200 }),
    ];
    expect(orderKanbanCards(notes).map((n) => n.id)).toEqual(['new', 'mid', 'old']);
  });

  it('sorts workflow columns by position ASC with createdAt DESC tie-break', () => {
    const notes = [
      makeNote({ id: 'a', status: 'todo', position: 2, createdAt: 1 }),
      makeNote({ id: 'b', status: 'todo', position: 1, createdAt: 1 }),
      makeNote({ id: 'c', status: 'todo', position: 1, createdAt: 5 }), // newer than b at same pos
    ];
    expect(orderKanbanCards(notes).map((n) => n.id)).toEqual(['c', 'b', 'a']);
  });

  it('treats null position as +Infinity (last in column)', () => {
    const notes = [
      makeNote({ id: 'pinned', status: 'todo', position: 0 }),
      makeNote({ id: 'tail', status: 'todo', position: null, createdAt: 100 }),
    ];
    expect(orderKanbanCards(notes).map((n) => n.id)).toEqual(['pinned', 'tail']);
  });
});

describe('bucketKanbanCards', () => {
  it('returns buckets pre-sorted in the same order as orderKanbanCards', () => {
    const notes = [
      makeNote({ id: 'a', status: 'todo', position: 2 }),
      makeNote({ id: 'b', status: 'todo', position: 1 }),
      makeNote({ id: 'n1', status: 'note', updatedAt: 10 }),
      makeNote({ id: 'n2', status: 'note', updatedAt: 20 }),
    ];
    const buckets = bucketKanbanCards(notes);
    expect(buckets.todo.map((n) => n.id)).toEqual(['b', 'a']);
    expect(buckets.note.map((n) => n.id)).toEqual(['n2', 'n1']);
    expect(buckets.backlog).toEqual([]);
    expect(buckets.done).toEqual([]);
  });
});

describe('kanbanCardNeighbours', () => {
  const notes = [
    makeNote({ id: 'n1', status: 'note', updatedAt: 20 }),
    makeNote({ id: 'n2', status: 'note', updatedAt: 10 }),
    makeNote({ id: 't1', status: 'todo', position: 0 }),
    makeNote({ id: 't2', status: 'todo', position: 1 }),
    makeNote({ id: 'd1', status: 'done', position: 0 }),
  ];
  // Flat order: n1, n2, t1, t2, d1

  it('returns null prev for the very first card', () => {
    expect(kanbanCardNeighbours(notes, 'n1')).toEqual({ prevId: null, nextId: 'n2' });
  });

  it('returns null next for the very last card', () => {
    expect(kanbanCardNeighbours(notes, 'd1')).toEqual({ prevId: 't2', nextId: null });
  });

  it('wraps across column boundaries', () => {
    expect(kanbanCardNeighbours(notes, 'n2')).toEqual({ prevId: 'n1', nextId: 't1' });
    expect(kanbanCardNeighbours(notes, 't2')).toEqual({ prevId: 't1', nextId: 'd1' });
  });

  it('returns both null when the id is not in the list', () => {
    expect(kanbanCardNeighbours(notes, 'missing')).toEqual({ prevId: null, nextId: null });
  });

  it('returns both null when the list is empty', () => {
    expect(kanbanCardNeighbours([], 'anything')).toEqual({ prevId: null, nextId: null });
  });
});

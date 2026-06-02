import { describe, it, expect } from 'vitest';
import {
  findContainer,
  resolveDropTarget,
} from '../src/web/src/layout/kanban/dnd-resolve';
import type { Note, NoteStatus } from '../src/web/src/lib/api';

function makeNote(id: string, status: NoteStatus, position = 0): Note {
  return {
    id,
    folderId: 'f1',
    title: id,
    body: '',
    pinned: false,
    source: 'user',
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    archivedAt: null,
    status,
    position,
    tags: [],
    mcpPermissions: { visible: null, update: null, delete: null },
  };
}

function makeColumns(): Record<NoteStatus, Note[]> {
  return {
    note: [makeNote('n1', 'note')],
    backlog: [makeNote('b1', 'backlog', 1), makeNote('b2', 'backlog', 2)],
    todo: [
      makeNote('t1', 'todo', 1),
      makeNote('t2', 'todo', 2),
      makeNote('t3', 'todo', 3),
    ],
    doing: [],
    review: [makeNote('r1', 'review', 1)],
    done: [],
  };
}

describe('findContainer', () => {
  it('returns the column key for a known card', () => {
    const cols = makeColumns();
    expect(findContainer(cols, 'b1')).toBe('backlog');
    expect(findContainer(cols, 't3')).toBe('todo');
    expect(findContainer(cols, 'r1')).toBe('review');
  });

  it('returns null for an unknown id', () => {
    expect(findContainer(makeColumns(), 'ghost')).toBeNull();
  });
});

describe('resolveDropTarget', () => {
  it('drops on a column id → top-of-column with afterNoteId=null', () => {
    const r = resolveDropTarget(makeColumns(), 'b1', 'col:doing');
    expect(r).toEqual({ kind: 'move', targetStatus: 'doing', afterNoteId: null });
  });

  it('drops on an empty column → still resolves to top-of-column', () => {
    const r = resolveDropTarget(makeColumns(), 't1', 'col:done');
    expect(r).toEqual({ kind: 'move', targetStatus: 'done', afterNoteId: null });
  });

  it('drops on a sibling card → afterNoteId is sibling PREDECESSOR (Trello/Linear semantics)', () => {
    // Drop t3 on top of t2 → place after t1 (predecessor of t2 in filtered list)
    const r = resolveDropTarget(makeColumns(), 't3', 't2');
    expect(r).toEqual({ kind: 'move', targetStatus: 'todo', afterNoteId: 't1' });
  });

  it('drops on the top-most sibling card → afterNoteId=null (top-of-column)', () => {
    // Drop t3 on t1 (topmost) → top-of-column
    const r = resolveDropTarget(makeColumns(), 't3', 't1');
    expect(r).toEqual({ kind: 'move', targetStatus: 'todo', afterNoteId: null });
  });

  it('cross-column sibling drop puts the card just before the sibling', () => {
    // Drop b1 on t2 (in todo) — filtered todo list is [t1, t2, t3], t2 is at index 1, predecessor is t1
    const r = resolveDropTarget(makeColumns(), 'b1', 't2');
    expect(r).toEqual({ kind: 'move', targetStatus: 'todo', afterNoteId: 't1' });
  });

  it('drop on self is a no-op', () => {
    expect(resolveDropTarget(makeColumns(), 't2', 't2')).toEqual({ kind: 'noop' });
  });

  it('unknown overId is a no-op', () => {
    expect(resolveDropTarget(makeColumns(), 't2', 'ghost')).toEqual({ kind: 'noop' });
  });

  it('unknown activeId is a no-op (not in any column)', () => {
    expect(resolveDropTarget(makeColumns(), 'ghost', 'col:todo')).toEqual({
      kind: 'noop',
    });
  });

  it('same-column drop where wanted index equals current index is a no-op', () => {
    // t2 is at index 1 in todo. Dropping t2 on t3 → predecessor of t3 in
    // filtered list [t1, t3] is t1, wanted index = 1 = currentIndex → noop.
    expect(resolveDropTarget(makeColumns(), 't2', 't3')).toEqual({ kind: 'noop' });
  });

  it('same-column drop on top of self collapses to top-of-column when sibling is first', () => {
    // Drop t1 on t1 itself is rejected by the self-check. Drop t2 on t1
    // means top-of-column; t2 is at index 1, wanted is 0 → real move.
    expect(resolveDropTarget(makeColumns(), 't2', 't1')).toEqual({
      kind: 'move',
      targetStatus: 'todo',
      afterNoteId: null,
    });
  });

  it('same-column re-drop at the very same top is a noop', () => {
    // Drop t1 on col:todo → afterNoteId=null. Currently t1 is at index 0
    // and wanted is 0 → noop.
    expect(resolveDropTarget(makeColumns(), 't1', 'col:todo')).toEqual({ kind: 'noop' });
  });

  it('cross-column drop on column id targets the column even if column is non-empty', () => {
    const r = resolveDropTarget(makeColumns(), 'b1', 'col:review');
    expect(r).toEqual({ kind: 'move', targetStatus: 'review', afterNoteId: null });
  });
});

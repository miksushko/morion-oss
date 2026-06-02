import { describe, it, expect } from 'vitest';
import type { Note } from '../src/web/src/lib/api';
import { groupNotesByDate } from '../src/web/src/layout/notes-list/group';

function makeNote(
  id: string,
  partial: Partial<Note> & { updatedAt: number },
): Note {
  return {
    id,
    folderId: null,
    title: id,
    body: '',
    pinned: partial.pinned ?? false,
    source: 'user',
    createdAt: partial.updatedAt,
    updatedAt: partial.updatedAt,
    deletedAt: partial.deletedAt ?? null,
    archivedAt: null,
    status: 'note',
    position: null,
    tags: [],
    mcpPermissions: { visible: null, update: null, delete: null },
  };
}

describe('groupNotesByDate', () => {
  // Sat 2026-05-16 14:00 local. `groupByDate` bucket math is local-tz
  // based; tests stay deterministic because we pass `now` explicitly.
  const NOW = new Date(2026, 4, 16, 14, 0, 0, 0).getTime();
  const DAY = 86_400_000;

  it('returns empty array for empty input', () => {
    expect(groupNotesByDate([], 'updatedAt', { now: NOW })).toEqual([]);
  });

  it('buckets notes into Today / Yesterday / Previous 7 Days', () => {
    const notes = [
      makeNote('a', { updatedAt: NOW - 1000 }), // Today
      makeNote('b', { updatedAt: NOW - 1.5 * DAY }), // Yesterday
      makeNote('c', { updatedAt: NOW - 4 * DAY }), // Previous 7 Days
    ];
    const groups = groupNotesByDate(notes, 'updatedAt', { now: NOW });
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(['Today', 'Yesterday', 'Previous 7 Days']);
    expect(groups[0]?.notes.map((n) => n.id)).toEqual(['a']);
    expect(groups[1]?.notes.map((n) => n.id)).toEqual(['b']);
    expect(groups[2]?.notes.map((n) => n.id)).toEqual(['c']);
  });

  it('pulls pinned notes into a leading "Pinned" group regardless of timestamp', () => {
    const notes = [
      makeNote('today-pinned', { updatedAt: NOW - 1000, pinned: true }),
      makeNote('old-pinned', { updatedAt: NOW - 60 * DAY, pinned: true }),
      makeNote('today-unpinned', { updatedAt: NOW - 1000 }),
    ];
    const groups = groupNotesByDate(notes, 'updatedAt', { now: NOW });
    expect(groups[0]?.label).toBe('Pinned');
    expect(groups[0]?.notes.map((n) => n.id)).toEqual([
      'today-pinned',
      'old-pinned',
    ]);
    // Unpinned same-day note still gets its own Today group.
    const today = groups.find((g) => g.label === 'Today');
    expect(today?.notes.map((n) => n.id)).toEqual(['today-unpinned']);
  });

  it('uses deletedAt when tsKey is "deletedAt"', () => {
    const notes = [
      // updatedAt is recent (Today), deletedAt is 4 days ago — should
      // bucket by deletedAt → Previous 7 Days.
      makeNote('trashed', {
        updatedAt: NOW - 1000,
        deletedAt: NOW - 4 * DAY,
      }),
    ];
    const groups = groupNotesByDate(notes, 'deletedAt', { now: NOW });
    expect(groups[0]?.label).toBe('Previous 7 Days');
  });

  it('falls back to updatedAt when deletedAt is null and tsKey is "deletedAt"', () => {
    // Defensive: a not-actually-deleted note rendered in deletedAt mode
    // (shouldn't happen in production but is documented behaviour) buckets
    // by updatedAt rather than crashing on null.
    const notes = [
      makeNote('not-deleted', { updatedAt: NOW - 1000 }),
    ];
    const groups = groupNotesByDate(notes, 'deletedAt', { now: NOW });
    expect(groups[0]?.label).toBe('Today');
  });

  it('preserves first-encountered order across multiple buckets', () => {
    const notes = [
      makeNote('a', { updatedAt: NOW - 1000 }), // Today
      makeNote('b', { updatedAt: NOW - 60 * DAY }), // older bucket
      makeNote('c', { updatedAt: NOW - 2000 }), // Today (later in list)
    ];
    const groups = groupNotesByDate(notes, 'updatedAt', { now: NOW });
    // Today was seen first, older bucket second — that order MUST hold
    // regardless of when items within them arrived.
    expect(groups[0]?.label).toBe('Today');
    expect(groups[0]?.notes.map((n) => n.id)).toEqual(['a', 'c']);
  });
});

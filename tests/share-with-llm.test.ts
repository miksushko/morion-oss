import { describe, it, expect } from 'vitest';
import { formatNoteShare, formatFolderShare } from '../src/web/src/lib/shareWithLLM';
import type { Note, Folder } from '../src/web/src/lib/api';

const baseNote: Note = {
  id: '01ABCDEFGHJKMNPQRSTVWXYZ00',
  folderId: 'fld1',
  title: 'Pizza for lunch',
  body: 'I had pizza on 2026-04-10. It was delicious.',
  pinned: false,
  source: 'user',
  createdAt: 1,
  updatedAt: 2,
  deletedAt: null,
  tags: ['food', 'lunch'],
};

const baseFolder: Folder = {
  id: 'fld1',
  name: 'Daily',
  parentId: null,
  position: 0,
  createdAt: 1,
  noteCount: 1,
};

describe('formatNoteShare', () => {
  it('returns one-line reference with title and id', () => {
    const out = formatNoteShare(baseNote);
    expect(out).toBe('Morion note "Pizza for lunch" (01ABCDEFGHJKMNPQRSTVWXYZ00)');
  });

  it('does NOT embed the body', () => {
    const out = formatNoteShare(baseNote);
    expect(out).not.toContain('pizza on 2026-04-10');
  });
});

describe('formatFolderShare', () => {
  it('returns one-line reference with name, id, and count', () => {
    const out = formatFolderShare(baseFolder, 5);
    expect(out).toBe('Morion folder "Daily" (fld1), 5 notes');
  });

  it('uses singular "note" for count of 1', () => {
    const out = formatFolderShare(baseFolder, 1);
    expect(out).toContain('1 note');
    expect(out).not.toContain('1 notes');
  });

  it('handles zero notes', () => {
    const out = formatFolderShare(baseFolder, 0);
    expect(out).toContain('0 notes');
  });
});

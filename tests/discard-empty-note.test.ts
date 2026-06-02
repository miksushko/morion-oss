import { describe, it, expect } from 'vitest';
import { isEmptyDraftNote } from '../src/web/src/lib/discardEmptyNote';

describe('isEmptyDraftNote', () => {
  it('treats a genuinely empty note as a draft', () => {
    expect(isEmptyDraftNote({ body: '' })).toBe(true);
  });

  it('treats whitespace-only body as empty (Tiptap can leave a stray newline)', () => {
    expect(isEmptyDraftNote({ body: '\n\n' })).toBe(true);
  });

  it('treats a lone # (empty H1 from Tiptap) as empty', () => {
    expect(isEmptyDraftNote({ body: '#' })).toBe(true);
  });

  it('treats "# " (H1 with trailing space) as empty', () => {
    expect(isEmptyDraftNote({ body: '# ' })).toBe(true);
  });

  it('treats "# \\n" (H1 + newline from Tiptap) as empty', () => {
    expect(isEmptyDraftNote({ body: '# \n' })).toBe(true);
  });

  it('treats ## and ### (empty H2/H3) as empty', () => {
    expect(isEmptyDraftNote({ body: '##' })).toBe(true);
    expect(isEmptyDraftNote({ body: '### ' })).toBe(true);
  });

  it('treats multiple empty heading lines as empty', () => {
    expect(isEmptyDraftNote({ body: '#\n##\n### ' })).toBe(true);
  });

  it('any non-whitespace body content keeps the note', () => {
    expect(isEmptyDraftNote({ body: 'hi' })).toBe(false);
  });

  it('heading with text keeps the note', () => {
    expect(isEmptyDraftNote({ body: '# Hello' })).toBe(false);
  });

  it('tags do NOT count as content — empty body with tags is still empty', () => {
    expect(isEmptyDraftNote({ body: '' })).toBe(true);
    expect(isEmptyDraftNote({ body: '# ' })).toBe(true);
  });
});

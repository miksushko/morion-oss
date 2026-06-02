import { describe, it, expect } from 'vitest';
import { deriveTitleFromBody } from '../src/core/notes/title.js';

describe('deriveTitleFromBody', () => {
  it('returns empty for empty string', () => {
    expect(deriveTitleFromBody('')).toBe('');
  });

  it('returns empty for whitespace only', () => {
    expect(deriveTitleFromBody('   \n\n  \n ')).toBe('');
  });

  it('picks the first non-blank line', () => {
    expect(deriveTitleFromBody('\n\n\nHello world\nSecond line')).toBe('Hello world');
  });

  it('strips # heading marker', () => {
    expect(deriveTitleFromBody('# My Title')).toBe('My Title');
  });

  it('strips ## heading marker', () => {
    expect(deriveTitleFromBody('## Sub heading')).toBe('Sub heading');
  });

  it('strips ### heading marker', () => {
    expect(deriveTitleFromBody('### Third')).toBe('Third');
  });

  it('strips ###### heading marker', () => {
    expect(deriveTitleFromBody('###### Deep')).toBe('Deep');
  });

  it('strips - list marker', () => {
    expect(deriveTitleFromBody('- List item')).toBe('List item');
  });

  it('strips * list marker', () => {
    expect(deriveTitleFromBody('* Star item')).toBe('Star item');
  });

  it('strips + list marker', () => {
    expect(deriveTitleFromBody('+ Plus item')).toBe('Plus item');
  });

  it('strips 1. ordered list marker', () => {
    expect(deriveTitleFromBody('1. First')).toBe('First');
  });

  it('strips > blockquote marker', () => {
    expect(deriveTitleFromBody('> Quoted text')).toBe('Quoted text');
  });

  it('strips task list checkbox', () => {
    expect(deriveTitleFromBody('- [ ] Todo item')).toBe('Todo item');
    expect(deriveTitleFromBody('- [x] Done item')).toBe('Done item');
  });

  it('does NOT strip markers from mid-line', () => {
    expect(deriveTitleFromBody('Hello # world')).toBe('Hello # world');
  });

  it('truncates at 100 chars on word boundary', () => {
    const long = 'A '.repeat(60); // 120 chars
    const title = deriveTitleFromBody(long);
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title).not.toMatch(/\s$/);
  });

  it('hard-cuts at 100 if no good break point', () => {
    const nospaces = 'X'.repeat(150);
    const title = deriveTitleFromBody(nospaces);
    expect(title.length).toBe(100);
  });

  it('ignores second line', () => {
    expect(deriveTitleFromBody('First\nSecond')).toBe('First');
  });

  it('handles plain text without markers', () => {
    expect(deriveTitleFromBody('Just some text')).toBe('Just some text');
  });

  it('stays fast and bounded on a multi-MB body (audit N22)', () => {
    // An MCP client dumping a 20 MB transcript into a note used to force
    // `body.split("\n")` to allocate the full array. After the 8 KB scan
    // cap, title derivation is O(1) in the body length.
    const heading = '# Big dump\n\n';
    const huge = heading + 'x'.repeat(20 * 1024 * 1024);
    const start = Date.now();
    const title = deriveTitleFromBody(huge);
    const elapsed = Date.now() - start;
    expect(title).toBe('Big dump');
    // Generous ceiling — on any reasonable machine this finishes well
    // under 50ms. Before the fix, the split alone was hundreds of ms.
    expect(elapsed).toBeLessThan(500);
  });

  it('still finds the title when the first line sits past a short leading gap', () => {
    // Regression: the scan cap must not be so tight that normal notes
    // with a few leading blank lines miss their title.
    const body = '\n'.repeat(50) + 'Actual title\n' + 'more body';
    expect(deriveTitleFromBody(body)).toBe('Actual title');
  });

  // Direction P — inline image support. Without these rules, a paste-
  // image-as-first-line note would produce a title like
  // `![screenshot](morion://attachment/01K…)`.

  it('uses alt text as title when the first line is an image-only line', () => {
    expect(
      deriveTitleFromBody('![Quarterly chart](morion://attachment/01K8Z9)'),
    ).toBe('Quarterly chart');
  });

  it('falls through an image-only line with empty alt to the next line', () => {
    // Paste-from-clipboard usually has empty alt because browsers
    // don't provide a filename. Title should come from the real text.
    const body = '![](morion://attachment/01K8Z9)\n\nReal title here\nbody';
    expect(deriveTitleFromBody(body)).toBe('Real title here');
  });

  it('returns empty when every early line is an empty-alt image', () => {
    const body = '![](morion://attachment/A)\n![](morion://attachment/B)\n';
    expect(deriveTitleFromBody(body)).toBe('');
  });

  it('strips a leading inline image from a prose first line', () => {
    expect(
      deriveTitleFromBody(
        '![chart](morion://attachment/01K) Q3 revenue recap',
      ),
    ).toBe('Q3 revenue recap');
  });

  it('strips heading + leading inline image together', () => {
    expect(
      deriveTitleFromBody(
        '# ![icon](morion://attachment/01K) Project kickoff',
      ),
    ).toBe('Project kickoff');
  });

  it('passes through an image in the middle of a line unchanged', () => {
    // The regex is LEADING only — an image mid-sentence is part of the
    // title. Callers who want a stripped preview can apply their own
    // logic; title derivation is conservative.
    expect(
      deriveTitleFromBody('Before ![chart](morion://attachment/01K) after'),
    ).toBe('Before ![chart](morion://attachment/01K) after');
  });
});

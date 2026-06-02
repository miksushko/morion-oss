import { describe, it, expect } from 'vitest';
import {
  formatUpdated,
  previewFor,
} from '../src/web/src/layout/notes-list/format';

describe('previewFor', () => {
  it('returns empty string for empty body', () => {
    expect(previewFor('')).toBe('');
  });

  it('returns empty string when body has only a title (no snippet)', () => {
    expect(previewFor('Title only')).toBe('');
    expect(previewFor('Title only\n')).toBe('');
    expect(previewFor('  Title  \n   \n  ')).toBe('');
  });

  it('returns the first non-empty line AFTER the title', () => {
    expect(previewFor('Title\n\nbody snippet')).toBe('body snippet');
    expect(previewFor('Title\nline2\nline3')).toBe('line2');
  });

  it('strips leading markdown header markers from BOTH title and snippet', () => {
    expect(previewFor('# Title\n## Section heading')).toBe('Section heading');
    expect(previewFor('### h3\nbody')).toBe('body');
  });

  it('skips blank lines between title and snippet', () => {
    expect(previewFor('Title\n\n\n   \n   body  ')).toBe('body');
  });

  it('treats lines that are only whitespace as empty', () => {
    expect(previewFor('Title\n   \nbody')).toBe('body');
  });

  it('returns trimmed text (no leading / trailing whitespace)', () => {
    expect(previewFor('Title\n   indented snippet   ')).toBe('indented snippet');
  });
});

describe('formatUpdated', () => {
  // Sat 2026-05-16 14:00 local. Fixed clock for deterministic boundaries.
  const NOW = new Date(2026, 4, 16, 14, 0, 0, 0).getTime();

  it('renders same-day timestamps as HH:MM', () => {
    const sameDayMorning = new Date(2026, 4, 16, 9, 5, 0, 0).getTime();
    const out = formatUpdated(sameDayMorning, NOW);
    // Format depends on locale, but the digits 09 and 05 must be present.
    expect(out).toMatch(/\b9|09\b/);
    expect(out).toContain('05');
  });

  it('renders non-same-day timestamps as month + day', () => {
    const yesterday = new Date(2026, 4, 15, 12, 0, 0, 0).getTime();
    const out = formatUpdated(yesterday, NOW);
    // Default `en-US` short-month form is "May 15".
    expect(out).toMatch(/May|Май|май/);
    expect(out).toContain('15');
  });

  it('treats midnight crossover as a different day even when seconds apart', () => {
    const justBeforeMidnight = new Date(2026, 4, 15, 23, 59, 59, 999).getTime();
    const justAfterMidnight = new Date(2026, 4, 16, 0, 0, 0, 0).getTime();
    // NOW is on the 16th — first is "yesterday" (date label), second is
    // same-day (time label).
    const before = formatUpdated(justBeforeMidnight, NOW);
    const after = formatUpdated(justAfterMidnight, NOW);
    expect(before).toContain('15');
    // After-midnight stamp is same-day → time label, contains a colon.
    expect(after).toContain(':');
  });

  it('treats December → January wrap as different day', () => {
    const dec31 = new Date(2025, 11, 31, 12, 0, 0, 0).getTime();
    const jan1Now = new Date(2026, 0, 1, 10, 0, 0, 0).getTime();
    const out = formatUpdated(dec31, jan1Now);
    expect(out).toContain('31');
  });
});

import { describe, expect, it } from 'vitest';
import { stripPlaceholder } from '../src/web/src/components/folder-settings/helpers';

describe('stripPlaceholder', () => {
  it('returns empty string for single-line italic placeholder', () => {
    expect(stripPlaceholder('_Mo will fill this in on the next patrol._')).toBe(
      '',
    );
  });

  it('strips placeholder with surrounding whitespace', () => {
    expect(stripPlaceholder('  _placeholder text_  ')).toBe('');
  });

  it('keeps real prose unchanged', () => {
    expect(stripPlaceholder('Real summary written by the user.')).toBe(
      'Real summary written by the user.',
    );
  });

  it('keeps multi-line italic content (not a placeholder)', () => {
    const multi = '_first line_\n_second line_';
    expect(stripPlaceholder(multi)).toBe(multi);
  });

  it('keeps prose that contains underscores but does not wrap them', () => {
    expect(stripPlaceholder('snake_case is fine')).toBe('snake_case is fine');
  });

  it('keeps prose that only starts with an underscore', () => {
    expect(stripPlaceholder('_starts with underscore')).toBe(
      '_starts with underscore',
    );
  });

  it('keeps prose that only ends with an underscore', () => {
    expect(stripPlaceholder('ends with underscore_')).toBe(
      'ends with underscore_',
    );
  });

  it('returns empty input unchanged', () => {
    expect(stripPlaceholder('')).toBe('');
    expect(stripPlaceholder('   ')).toBe('   ');
  });
});

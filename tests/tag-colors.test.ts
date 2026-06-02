import { describe, it, expect } from 'vitest';
import {
  TAG_PALETTE,
  contrastRatio,
  isValidHex,
  normalizeHex,
  pickTextColor,
} from '../src/web/src/lib/tagColors.js';

describe('tag color palette', () => {
  it('exposes 36 swatches', () => {
    expect(TAG_PALETTE).toHaveLength(36);
  });

  it('every swatch has a unique normalized hex', () => {
    const seen = new Set<string>();
    for (const s of TAG_PALETTE) {
      const norm = normalizeHex(s.hex);
      expect(norm).not.toBeNull();
      expect(seen.has(norm!)).toBe(false);
      seen.add(norm!);
    }
  });

  it('every swatch clears WCAG AA 4.5:1 with the auto text color', () => {
    for (const s of TAG_PALETTE) {
      const { meetsAA, ratio } = pickTextColor(s.hex);
      expect(meetsAA, `${s.name} (${s.hex}) ratio ${ratio.toFixed(2)}`).toBe(true);
    }
  });
});

describe('hex utilities', () => {
  it('accepts 3- and 6-digit hex, rejects everything else', () => {
    expect(isValidHex('#fff')).toBe(true);
    expect(isValidHex('#FFFFFF')).toBe(true);
    expect(isValidHex('#1a2b3c')).toBe(true);
    expect(isValidHex('fff')).toBe(false);
    expect(isValidHex('#ggg')).toBe(false);
    expect(isValidHex('#12345')).toBe(false);
    expect(isValidHex('')).toBe(false);
  });

  it('expands 3-digit hex to 6 and lowercases', () => {
    expect(normalizeHex('#FFF')).toBe('#ffffff');
    expect(normalizeHex('#aBc')).toBe('#aabbcc');
    expect(normalizeHex('#1A2B3C')).toBe('#1a2b3c');
    expect(normalizeHex('garbage')).toBeNull();
  });
});

describe('contrast', () => {
  it('white on black is exactly 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('returns 1 for unparsable inputs (safe fallback)', () => {
    expect(contrastRatio('not-a-color', '#ffffff')).toBe(1);
  });

  it('pickTextColor picks white on a deep red and black on a pastel red', () => {
    const onDeep = pickTextColor('#b91c1c');
    expect(onDeep.color).toBe('#ffffff');
    expect(onDeep.meetsAA).toBe(true);

    const onSoft = pickTextColor('#fecaca');
    expect(onSoft.color).toBe('#111827');
    expect(onSoft.meetsAA).toBe(true);
  });
});

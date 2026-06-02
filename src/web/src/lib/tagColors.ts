/**
 * Curated WCAG-safe tag color palette + small contrast utilities.
 *
 * The 36 swatches below are 18 hues × 2 intensities (a deeper, saturated
 * variant and a softer, lighter variant). Both intensities are picked so
 * that *one* of {white text, near-black text} clears the WCAG AA 4.5:1
 * contrast ratio for normal text. `pickTextColor` returns whichever
 * variant wins for any hex (palette or custom).
 *
 * Layout note: the palette is grouped by hue so the picker UI shows two
 * rows of complementary swatches (deep on top, soft below) per hue
 * column. Keep the order; the UI relies on it.
 */

export interface TagSwatch {
  hex: string;
  name: string;
}

export const TAG_PALETTE: TagSwatch[] = [
  // Deep row — saturated, work with white text.
  { hex: '#b91c1c', name: 'Red' },
  { hex: '#c2410c', name: 'Orange' },
  { hex: '#a16207', name: 'Amber' },
  { hex: '#4d7c0f', name: 'Lime' },
  { hex: '#15803d', name: 'Green' },
  { hex: '#0f766e', name: 'Teal' },
  { hex: '#0e7490', name: 'Cyan' },
  { hex: '#0369a1', name: 'Sky' },
  { hex: '#1d4ed8', name: 'Blue' },
  { hex: '#4338ca', name: 'Indigo' },
  { hex: '#6d28d9', name: 'Violet' },
  { hex: '#7e22ce', name: 'Purple' },
  { hex: '#a21caf', name: 'Fuchsia' },
  { hex: '#be185d', name: 'Pink' },
  { hex: '#9f1239', name: 'Rose' },
  { hex: '#44403c', name: 'Stone' },
  { hex: '#374151', name: 'Slate' },
  { hex: '#111827', name: 'Ink' },

  // Soft row — pastel, work with near-black text.
  { hex: '#fecaca', name: 'Red soft' },
  { hex: '#fed7aa', name: 'Orange soft' },
  { hex: '#fde68a', name: 'Amber soft' },
  { hex: '#d9f99d', name: 'Lime soft' },
  { hex: '#bbf7d0', name: 'Green soft' },
  { hex: '#99f6e4', name: 'Teal soft' },
  { hex: '#a5f3fc', name: 'Cyan soft' },
  { hex: '#bae6fd', name: 'Sky soft' },
  { hex: '#bfdbfe', name: 'Blue soft' },
  { hex: '#c7d2fe', name: 'Indigo soft' },
  { hex: '#ddd6fe', name: 'Violet soft' },
  { hex: '#e9d5ff', name: 'Purple soft' },
  { hex: '#f5d0fe', name: 'Fuchsia soft' },
  { hex: '#fbcfe8', name: 'Pink soft' },
  { hex: '#fecdd3', name: 'Rose soft' },
  { hex: '#e7e5e4', name: 'Stone soft' },
  { hex: '#e5e7eb', name: 'Slate soft' },
  { hex: '#d1d5db', name: 'Ink soft' },
];

const NEAR_BLACK = '#111827';
const NEAR_WHITE = '#ffffff';

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidHex(value: string): boolean {
  return HEX_RE.test(value);
}

export function normalizeHex(value: string): string | null {
  if (!HEX_RE.test(value)) return null;
  let hex = value.slice(1);
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return `#${hex.toLowerCase()}`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  return [r, g, b];
}

/** Relative luminance per WCAG 2.x. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two hex colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const rgbA = hexToRgb(a);
  const rgbB = hexToRgb(b);
  if (!rgbA || !rgbB) return 1;
  const lumA = relativeLuminance(rgbA);
  const lumB = relativeLuminance(rgbB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Picks the better-readable text color (near-black or near-white) for a
 * background hex. Whichever variant has the higher contrast ratio wins;
 * `meetsAA` reports whether that ratio clears the 4.5:1 normal-text bar.
 */
export function pickTextColor(bg: string): { color: string; ratio: number; meetsAA: boolean } {
  const onBlack = contrastRatio(bg, NEAR_BLACK);
  const onWhite = contrastRatio(bg, NEAR_WHITE);
  const useBlack = onBlack >= onWhite;
  const ratio = useBlack ? onBlack : onWhite;
  return {
    color: useBlack ? NEAR_BLACK : NEAR_WHITE,
    ratio,
    meetsAA: ratio >= 4.5,
  };
}

/** Default chip color when a tag has no explicit color set. */
export const DEFAULT_TAG_BG = '#374151';

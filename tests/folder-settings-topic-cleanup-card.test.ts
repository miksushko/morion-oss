import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relativeLabel } from '../src/web/src/components/folder-settings/topics/TopicCleanupCard';

describe('relativeLabel', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for missing timestamps', () => {
    expect(relativeLabel(null)).toBe(null);
    expect(relativeLabel(undefined)).toBe(null);
    expect(relativeLabel(0)).toBe(null);
  });

  it('says "just now" for < 1 min ago', () => {
    expect(relativeLabel(NOW - 10_000)).toBe('just now');
    expect(relativeLabel(NOW)).toBe('just now');
  });

  it('uses minutes for < 1 hour', () => {
    expect(relativeLabel(NOW - 5 * 60_000)).toBe('5 min ago');
    expect(relativeLabel(NOW - 59 * 60_000)).toBe('59 min ago');
  });

  it('uses hours for 1h-48h', () => {
    expect(relativeLabel(NOW - 1 * 3_600_000)).toBe('1h ago');
    expect(relativeLabel(NOW - 47 * 3_600_000)).toBe('47h ago');
  });

  it('uses days for >= 48h', () => {
    expect(relativeLabel(NOW - 48 * 3_600_000)).toBe('2d ago');
    expect(relativeLabel(NOW - 10 * 86_400_000)).toBe('10d ago');
  });
});

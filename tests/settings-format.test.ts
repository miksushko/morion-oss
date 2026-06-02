import { describe, it, expect } from 'vitest';
import {
  formatPlatform,
  formatUsd,
} from '../src/web/src/components/settings/format';
import { TAB_SPECS } from '../src/web/src/components/settings/types';

describe('formatPlatform', () => {
  it('maps known Node platform ids to human labels', () => {
    expect(formatPlatform('darwin')).toBe('macOS');
    expect(formatPlatform('win32')).toBe('Windows');
    expect(formatPlatform('linux')).toBe('Linux');
  });

  it('passes unknown platforms through unchanged', () => {
    expect(formatPlatform('freebsd')).toBe('freebsd');
    expect(formatPlatform('')).toBe('');
  });
});

describe('formatUsd', () => {
  it('renders exactly $0.00 for zero', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('uses 4-decimal precision for values under one cent', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.0001)).toBe('$0.0001');
    expect(formatUsd(0.009999)).toBe('$0.0100');
  });

  it('uses 2-decimal precision for values at or above one cent', () => {
    expect(formatUsd(0.01)).toBe('$0.01');
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(42.5)).toBe('$42.50');
    expect(formatUsd(10_000)).toBe('$10000.00');
  });
});

describe('TAB_SPECS', () => {
  it('lists the seven settings tabs in the documented order', () => {
    expect(TAB_SPECS.map((t) => t.key)).toEqual([
      'general',
      'limits',
      'usage',
      'mo-agent',
      'mcp-server',
      'skills',
      'logs',
    ]);
  });

  it('places exactly one group divider before General and one before Mo Agent', () => {
    const grouped = TAB_SPECS.filter((t) => t.group);
    expect(grouped.map((t) => [t.key, t.group])).toEqual([
      ['general', 'Account'],
      ['mo-agent', 'Workspace'],
    ]);
  });
});

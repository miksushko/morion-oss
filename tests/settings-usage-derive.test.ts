import { describe, it, expect } from 'vitest';
import {
  derivePerKindStats,
  sumPerKindByBucket,
} from '../src/web/src/components/settings/usage/usage-derive';
import type { UsageKind, UsagePerKind } from '../src/web/src/lib/api';
import { validateCapDraft, capPercent } from '../src/web/src/components/settings/cap-validate';

function row(partial: Partial<UsagePerKind> & { kind: UsageKind }): UsagePerKind {
  return {
    kind: partial.kind,
    totalCostUsd: partial.totalCostUsd ?? 0,
    meteredCostUsd: partial.meteredCostUsd ?? 0,
    includedCostUsd: partial.includedCostUsd ?? 0,
    requestCount: partial.requestCount ?? 0,
    totalPromptTokens: partial.totalPromptTokens ?? 0,
    totalCompletionTokens: partial.totalCompletionTokens ?? 0,
    totalCachedTokens: partial.totalCachedTokens ?? 0,
    totalReasoningTokens: partial.totalReasoningTokens ?? 0,
    tokensCapturedCount: {
      prompt: partial.tokensCapturedCount?.prompt ?? 0,
      cached: partial.tokensCapturedCount?.cached ?? 0,
      reasoning: partial.tokensCapturedCount?.reasoning ?? 0,
    },
  };
}

describe('sumPerKindByBucket', () => {
  it('aggregates per-kind rows into tri-split buckets', () => {
    const rows: UsagePerKind[] = [
      row({ kind: 'chat', totalCostUsd: 1 }),
      row({ kind: 'mo_gather', totalCostUsd: 0.5 }),
      row({ kind: 'mo_indexing_tier1', totalCostUsd: 2 }),
      row({ kind: 'mo_topic_hygiene', totalCostUsd: 0.25 }),
      row({ kind: 'auto-code-fix', totalCostUsd: 3 }),
    ];
    const { totals, grand } = sumPerKindByBucket(rows);
    expect(totals.interactive).toBeCloseTo(1.5);
    expect(totals.background).toBeCloseTo(2.25);
    expect(totals['auto-code']).toBeCloseTo(3);
    expect(grand).toBeCloseTo(6.75);
  });

  it('returns all-zero totals on empty input', () => {
    const { totals, grand } = sumPerKindByBucket([]);
    expect(totals).toEqual({ interactive: 0, background: 0, 'auto-code': 0 });
    expect(grand).toBe(0);
  });

  it('skips unknown kinds silently', () => {
    const rows: UsagePerKind[] = [
      row({ kind: 'unknown-kind' as UsageKind, totalCostUsd: 99 }),
      row({ kind: 'chat', totalCostUsd: 1 }),
    ];
    const { totals, grand } = sumPerKindByBucket(rows);
    expect(totals.interactive).toBe(1);
    expect(grand).toBe(1);
  });
});

describe('derivePerKindStats', () => {
  it('returns null cache hit % when no row reported caching', () => {
    const r = row({
      kind: 'chat',
      requestCount: 10,
      totalPromptTokens: 5000,
      tokensCapturedCount: { prompt: 10, cached: 0, reasoning: 0 },
    });
    expect(derivePerKindStats(r).cacheHitPct).toBeNull();
  });

  it('computes cache hit % from totals when at least one row reported caching', () => {
    const r = row({
      kind: 'chat',
      totalPromptTokens: 1000,
      totalCachedTokens: 250,
      tokensCapturedCount: { prompt: 10, cached: 5, reasoning: 0 },
    });
    expect(derivePerKindStats(r).cacheHitPct).toBe(25);
  });

  it('computes avg prompt / completion tokens, normalised by promptCaptured', () => {
    const r = row({
      kind: 'chat',
      totalPromptTokens: 1000,
      totalCompletionTokens: 200,
      tokensCapturedCount: { prompt: 4, cached: 0, reasoning: 0 },
    });
    const stats = derivePerKindStats(r);
    expect(stats.avgPromptTokens).toBe(250);
    expect(stats.avgCompletionTokens).toBe(50);
  });

  it('returns null avg reasoning when no row reported reasoning tokens', () => {
    const r = row({
      kind: 'chat',
      totalReasoningTokens: 500,
      tokensCapturedCount: { prompt: 4, cached: 0, reasoning: 0 },
    });
    expect(derivePerKindStats(r).avgReasoning).toBeNull();
  });

  it('flags fullyIncluded when included > 0 and metered = 0', () => {
    const r = row({
      kind: 'auto-code-fix',
      meteredCostUsd: 0,
      includedCostUsd: 5,
    });
    const stats = derivePerKindStats(r);
    expect(stats.fullyIncluded).toBe(true);
    expect(stats.partiallyIncluded).toBe(false);
  });

  it('flags partiallyIncluded when both included and metered > 0', () => {
    const r = row({
      kind: 'auto-code-fix',
      meteredCostUsd: 1,
      includedCostUsd: 5,
    });
    const stats = derivePerKindStats(r);
    expect(stats.fullyIncluded).toBe(false);
    expect(stats.partiallyIncluded).toBe(true);
  });

  it('flags neither when nothing is included', () => {
    const r = row({
      kind: 'chat',
      meteredCostUsd: 2,
      includedCostUsd: 0,
    });
    const stats = derivePerKindStats(r);
    expect(stats.fullyIncluded).toBe(false);
    expect(stats.partiallyIncluded).toBe(false);
  });
});

describe('validateCapDraft', () => {
  it('flags empty / non-numeric strings as out-of-range with NaN', () => {
    const a = validateCapDraft('', 100);
    expect(a.outOfRange).toBe(true);
    expect(Number.isNaN(a.parsed)).toBe(true);
    const b = validateCapDraft('abc', 100);
    expect(b.outOfRange).toBe(true);
    expect(Number.isNaN(b.parsed)).toBe(true);
  });

  it('flags negative values as out-of-range', () => {
    const v = validateCapDraft('-1', 100);
    expect(v.outOfRange).toBe(true);
    expect(v.parsed).toBe(-1);
  });

  it('flags values above the max as out-of-range', () => {
    const v = validateCapDraft('101', 100);
    expect(v.outOfRange).toBe(true);
  });

  it('accepts values inside [0, maxCap]', () => {
    expect(validateCapDraft('0', 100)).toEqual({
      parsed: 0,
      outOfRange: false,
      isKillSwitch: true,
    });
    expect(validateCapDraft('50', 100)).toEqual({
      parsed: 50,
      outOfRange: false,
      isKillSwitch: false,
    });
    expect(validateCapDraft('100', 100)).toEqual({
      parsed: 100,
      outOfRange: false,
      isKillSwitch: false,
    });
  });

  it('flags exactly $0 as the kill-switch state', () => {
    expect(validateCapDraft('0', 100).isKillSwitch).toBe(true);
    expect(validateCapDraft('0.00', 100).isKillSwitch).toBe(true);
  });
});

describe('capPercent', () => {
  it('returns 0 when cap is zero (kill-switch)', () => {
    expect(capPercent(5, 0)).toBe(0);
  });

  it('caps at 100 when spend exceeds cap', () => {
    expect(capPercent(200, 100)).toBe(100);
  });

  it('returns proportional percent below the cap', () => {
    expect(capPercent(25, 100)).toBe(25);
    expect(capPercent(75, 100)).toBe(75);
  });
});

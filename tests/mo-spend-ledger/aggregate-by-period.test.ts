import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MoSpendLedgerRepository } from '../../src/core/concierge/index.js';
import { freshDb } from '../helpers/mo-spend-ledger-setup.js';

describe('MoSpendLedger — aggregateByPeriod (slice 5) + monthlyAutoCodeSplit (slice 12)', () => {
  let db: Database.Database;
  let ledger: MoSpendLedgerRepository;

  beforeEach(() => {
    db = freshDb();
    ledger = new MoSpendLedgerRepository(db);
  });

  it('aggregateByPeriod — per-kind breakdown with token sums + captured counts', () => {
    // Pins the slice-5 aggregator. The shape feeds Settings → Usage
    // directly (slice 6 HTTP route is a thin wrapper) so a drift here
    // breaks the dashboard.
    const t = Date.UTC(2026, 4, 10, 12, 0, 0);
    ledger.record(
      {
        kind: 'chat',
        costUsd: 0.005,
        provider: 'openrouter',
        model: 'x-ai/grok-4.1-fast',
        promptTokens: 1000,
        completionTokens: 300,
        cachedTokens: 600,
      },
      t,
    );
    ledger.record(
      {
        kind: 'chat',
        costUsd: 0.003,
        provider: 'openrouter',
        model: 'x-ai/grok-4.1-fast',
        promptTokens: 800,
        completionTokens: 200,
        cachedTokens: 500,
        reasoningTokens: 50,
      },
      t + 1,
    );
    // Pre-Slice-1 row (no token columns) lands in the same period.
    ledger.record({ kind: 'chat', costUsd: 0.001 }, t + 2);

    const agg = ledger.aggregateByPeriod(t, t + 1000);
    expect(agg.totalCostUsd).toBeCloseTo(0.009, 5);
    expect(agg.requestCount).toBe(3);

    const chat = agg.perKind.find((k) => k.kind === 'chat');
    expect(chat).toBeDefined();
    expect(chat!.totalCostUsd).toBeCloseTo(0.009, 5);
    expect(chat!.requestCount).toBe(3);
    expect(chat!.totalPromptTokens).toBe(1800);
    expect(chat!.totalCompletionTokens).toBe(500);
    expect(chat!.totalCachedTokens).toBe(1100);
    expect(chat!.totalReasoningTokens).toBe(50);
    // Capture counts let the UI render cache-hit % over the right
    // denominator — only 2 of 3 rows reported cached_tokens.
    expect(chat!.tokensCapturedCount.prompt).toBe(2);
    expect(chat!.tokensCapturedCount.cached).toBe(2);
    expect(chat!.tokensCapturedCount.reasoning).toBe(1);
  });

  it('aggregateByPeriod — per-provider + per-model + daily timeseries', () => {
    const t = Date.UTC(2026, 4, 10, 12, 0, 0);
    const dayLater = Date.UTC(2026, 4, 11, 12, 0, 0);
    ledger.record(
      {
        kind: 'mo_gather',
        costUsd: 0.02,
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash',
      },
      t,
    );
    ledger.record(
      {
        kind: 'mo_gather',
        costUsd: 0.01,
        provider: 'openrouter',
        model: 'qwen/qwen3.5-flash',
      },
      t + 1,
    );
    ledger.record(
      {
        kind: 'chat',
        costUsd: 0.005,
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      },
      dayLater,
    );

    const agg = ledger.aggregateByPeriod(t, dayLater + 1_000);

    // Per-provider — sorted by spend desc.
    expect(agg.perProvider.map((p) => p.provider)).toEqual(['openrouter', 'anthropic']);
    expect(agg.perProvider[0].totalCostUsd).toBeCloseTo(0.03, 5);
    expect(agg.perProvider[0].requestCount).toBe(2);

    // Per-model — also sorted desc; preserves provider attribution.
    expect(agg.perModel[0].model).toBe('deepseek/deepseek-v4-flash');
    expect(agg.perModel[0].provider).toBe('openrouter');
    expect(agg.perModel[0].totalCostUsd).toBeCloseTo(0.02, 5);
    expect(agg.perModel.length).toBe(3);

    // Daily — sparse, only days with rows, ascending date order.
    expect(agg.daily.length).toBe(2);
    expect(agg.daily[0].date).toBe('2026-05-10');
    expect(agg.daily[0].totalCostUsd).toBeCloseTo(0.03, 5);
    expect(agg.daily[0].requestCount).toBe(2);
    expect(agg.daily[1].date).toBe('2026-05-11');
    expect(agg.daily[1].totalCostUsd).toBeCloseTo(0.005, 5);
  });

  it('aggregateByPeriod — half-open range excludes the upper bound exactly', () => {
    const t = Date.UTC(2026, 4, 10, 12, 0, 0);
    ledger.record({ kind: 'chat', costUsd: 0.01 }, t - 1);
    ledger.record({ kind: 'chat', costUsd: 0.02 }, t);
    ledger.record({ kind: 'chat', costUsd: 0.04 }, t + 999);
    ledger.record({ kind: 'chat', costUsd: 0.08 }, t + 1000); // exclusive
    const agg = ledger.aggregateByPeriod(t, t + 1000);
    expect(agg.totalCostUsd).toBeCloseTo(0.06, 5); // 0.02 + 0.04 only
    expect(agg.requestCount).toBe(2);
  });

  it('aggregateByPeriod — empty window returns zeros and empty arrays', () => {
    const t = Date.UTC(2026, 4, 10, 12, 0, 0);
    ledger.record({ kind: 'chat', costUsd: 0.01 }, t);
    const agg = ledger.aggregateByPeriod(t + 1_000_000, t + 2_000_000);
    expect(agg.totalCostUsd).toBe(0);
    expect(agg.requestCount).toBe(0);
    expect(agg.perKind).toEqual([]);
    expect(agg.perProvider).toEqual([]);
    expect(agg.perModel).toEqual([]);
    expect(agg.daily).toEqual([]);
  });

  it('aggregateByPeriod splits totalCostUsd into meteredCostUsd + includedCostUsd (slice 12)', () => {
    // Mirrors the real-world auto-code Max-plan case: a single fix
    // call records the equivalent API price but auth_mode='subscription'
    // so the $1.80 should land in `included`, not `metered`.
    const t = Date.UTC(2026, 4, 10, 12, 0, 0);
    ledger.record(
      {
        kind: 'auto-code-fix',
        folderId: 'fld_1',
        costUsd: 1.8,
        authMode: 'subscription',
      },
      t,
    );
    ledger.record(
      {
        kind: 'chat',
        costUsd: 0.004,
        authMode: 'api',
      },
      t + 1,
    );
    ledger.record(
      // Pre-Slice-11 row — auth_mode NULL — counts as metered.
      { kind: 'mo_indexing_tier1', folderId: 'fld_1', costUsd: 0.002 },
      t + 2,
    );

    const agg = ledger.aggregateByPeriod(t, t + 1000);
    expect(agg.totalCostUsd).toBeCloseTo(1.806, 5);
    expect(agg.includedCostUsd).toBeCloseTo(1.8, 5);
    expect(agg.meteredCostUsd).toBeCloseTo(0.006, 5);

    const fix = agg.perKind.find((k) => k.kind === 'auto-code-fix')!;
    expect(fix.includedCostUsd).toBeCloseTo(1.8, 5);
    expect(fix.meteredCostUsd).toBe(0);

    const chat = agg.perKind.find((k) => k.kind === 'chat')!;
    expect(chat.includedCostUsd).toBe(0);
    expect(chat.meteredCostUsd).toBeCloseTo(0.004, 5);
  });

  it('monthlyAutoCodeSplit ignores non-auto-code kinds and respects month boundary (slice 12)', () => {
    const now = Date.UTC(2026, 4, 15, 12, 0, 0);
    ledger.record(
      { kind: 'auto-code-fix', folderId: 'fld_1', costUsd: 1.0, authMode: 'subscription' },
      now,
    );
    ledger.record(
      { kind: 'auto-code-review', folderId: 'fld_1', costUsd: 0.5, authMode: 'subscription' },
      now,
    );
    ledger.record(
      { kind: 'auto-code-merge-resolve', folderId: 'fld_1', costUsd: 0.12, authMode: 'api' },
      now,
    );
    // Mo orchestration — must not count toward auto-code split.
    ledger.record({ kind: 'chat', costUsd: 5, authMode: 'api' }, now);
    // Last month — must not count.
    ledger.record(
      { kind: 'auto-code-fix', folderId: 'fld_1', costUsd: 99, authMode: 'subscription' },
      Date.UTC(2026, 3, 28, 12, 0, 0),
    );

    const split = ledger.monthlyAutoCodeSplit(now);
    expect(split.included).toBeCloseTo(1.5, 5);
    expect(split.metered).toBeCloseTo(0.12, 5);
  });
});

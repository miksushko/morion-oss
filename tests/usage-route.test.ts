import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { openDb } from '../src/core/db/client.js';
import {
  BudgetTracker,
  ConciergeFolderSettingsRepository,
  ConciergeMessagesRepository,
  ConciergeSessionsRepository,
  MoMemoryRepository,
  MoSpendLedgerRepository,
} from '../src/core/concierge/index.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { resolveUsagePeriod, registerUsageRoutes } from '../src/server/routes/concierge/usage.js';
import { startOfUtcMonth } from '../src/core/concierge/mo-spend-ledger.js';

/**
 * Behavioural pin for `GET /api/usage` (ticket 01KRJSTN74FT7VRX6KAA42GGBS
 * slice 6). The registration-only smoke lives in
 * `tests/concierge-route-registration.test.ts`. This file covers:
 *  - period parameter parsing + invalid_period error
 *  - period → [from, to) resolution (pure helper, no HTTP)
 *  - body shape (aggregate + moCap + autoCodeCap)
 *  - concierge_not_wired envelope on a runtime missing the bag
 */
describe('resolveUsagePeriod', () => {
  it('current_month: from = start of UTC month, to = now', () => {
    const now = Date.UTC(2026, 4, 15, 10, 0, 0);
    const r = resolveUsagePeriod('current_month', now);
    expect(r.from).toBe(Date.UTC(2026, 4, 1, 0, 0, 0));
    expect(r.to).toBe(now);
  });

  it('last_month: from = start of previous UTC month, to = start of current', () => {
    const now = Date.UTC(2026, 4, 15, 10, 0, 0);
    const r = resolveUsagePeriod('last_month', now);
    expect(r.from).toBe(Date.UTC(2026, 3, 1, 0, 0, 0));
    expect(r.to).toBe(Date.UTC(2026, 4, 1, 0, 0, 0));
  });

  it('last_month: wraps year boundary (January → previous December)', () => {
    const jan = Date.UTC(2026, 0, 10, 0, 0, 0);
    const r = resolveUsagePeriod('last_month', jan);
    expect(r.from).toBe(Date.UTC(2025, 11, 1, 0, 0, 0));
    expect(r.to).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
  });

  it('last_7d: rolling 7-day window ending now', () => {
    const now = Date.UTC(2026, 4, 15, 10, 0, 0);
    const r = resolveUsagePeriod('last_7d', now);
    expect(r.from).toBe(now - 7 * 24 * 3600 * 1000);
    expect(r.to).toBe(now);
  });

  it('last_30d: rolling 30-day window ending now', () => {
    const now = Date.UTC(2026, 4, 15, 10, 0, 0);
    const r = resolveUsagePeriod('last_30d', now);
    expect(r.from).toBe(now - 30 * 24 * 3600 * 1000);
    expect(r.to).toBe(now);
  });

  it('all_time: from = 0 (epoch), to = now', () => {
    const now = Date.UTC(2026, 4, 15, 10, 0, 0);
    const r = resolveUsagePeriod('all_time', now);
    expect(r.from).toBe(0);
    expect(r.to).toBe(now);
  });
});

interface MockContext {
  db: ReturnType<typeof openDb>['db'];
  settings: SettingsRepository;
  concierge: {
    folderSettings: ConciergeFolderSettingsRepository;
    sessions: ConciergeSessionsRepository;
    messages: ConciergeMessagesRepository;
    moSpendLedger: MoSpendLedgerRepository;
    moMemory: MoMemoryRepository;
    budget: BudgetTracker;
  };
}

function setup(): { app: Hono; ledger: MoSpendLedgerRepository; ctx: MockContext } {
  const { db } = openDb({ path: ':memory:' });
  const settings = new SettingsRepository(db);
  const ledger = new MoSpendLedgerRepository(db);
  const budget = new BudgetTracker(ledger);
  const ctx: MockContext = {
    db,
    settings,
    concierge: {
      folderSettings: new ConciergeFolderSettingsRepository(db),
      sessions: new ConciergeSessionsRepository(db),
      messages: new ConciergeMessagesRepository(db),
      moSpendLedger: ledger,
      moMemory: new MoMemoryRepository(settings),
      budget,
    },
  };
  const app = new Hono();
  // ToolContext shape is broader; cast through unknown for the test
  // harness — we only need .concierge + .settings + .db here.
  registerUsageRoutes(app, ctx as unknown as Parameters<typeof registerUsageRoutes>[1]);
  return { app, ledger, ctx };
}

describe('GET /api/usage — HTTP envelope', () => {
  it('rejects an invalid period with 400 + invalid_period', async () => {
    const { app } = setup();
    const res = await app.request('/api/usage?period=lifetime');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_period');
  });

  it('defaults to current_month when period is omitted', async () => {
    const { app, ledger } = setup();
    const inThisMonth = startOfUtcMonth(Date.now()) + 1000;
    ledger.record(
      {
        kind: 'chat',
        costUsd: 0.0042,
        provider: 'openrouter',
        model: 'x-ai/grok-4.1-fast',
        promptTokens: 100,
        completionTokens: 30,
      },
      inThisMonth,
    );
    const res = await app.request('/api/usage');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period).toBe('current_month');
    expect(body.totalCostUsd).toBeCloseTo(0.0042, 5);
    expect(body.requestCount).toBe(1);
    expect(body.perKind.find((k: { kind: string }) => k.kind === 'chat')).toBeDefined();
  });

  it('returns full aggregate + moCap + autoCodeCap envelope', async () => {
    const { app } = setup();
    const res = await app.request('/api/usage?period=last_7d');
    expect(res.status).toBe(200);
    const body = await res.json();

    // Aggregate fields from MoSpendLedgerRepository.aggregateByPeriod.
    expect(body).toHaveProperty('from');
    expect(body).toHaveProperty('to');
    expect(body).toHaveProperty('perKind');
    expect(body).toHaveProperty('perProvider');
    expect(body).toHaveProperty('perModel');
    expect(body).toHaveProperty('daily');

    // Cap envelopes — same shape as their dedicated routes return.
    expect(body.moCap).toBeDefined();
    expect(body.moCap.monthlyCapUsd).toBeGreaterThan(0);
    expect(body.moCap.spentMonthBreakdown).toBeDefined();
    expect(body.moCap.spentMonthBreakdown.mo_indexing_tier1).toBeDefined();
    expect(body.autoCodeCap).toBeDefined();
    expect(body.autoCodeCap.monthlyCapUsd).toBeGreaterThan(0);
    expect(body.autoCodeCapMaxUsd).toBeGreaterThan(0);
    expect(body.nextMonthResetAt).toBeGreaterThan(body.to);
  });

  it('empty ledger surfaces zero totals + empty arrays (no Free-wall)', async () => {
    const { app } = setup();
    const res = await app.request('/api/usage?period=all_time');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCostUsd).toBe(0);
    expect(body.requestCount).toBe(0);
    expect(body.perKind).toEqual([]);
    expect(body.perProvider).toEqual([]);
    expect(body.perModel).toEqual([]);
    expect(body.daily).toEqual([]);
    // moCap still present — UI shows "$0 / $10" with full bar empty.
    expect(body.moCap.spentMonthUsd).toBe(0);
  });
});

describe('GET /api/usage — concierge_not_wired envelope', () => {
  it('returns 501 when ToolContext lacks the concierge bag', async () => {
    // Some runtimes (mcpb slim, future test fixtures) ship without
    // the concierge bag. Make sure the route surfaces a clean 501
    // instead of a crash on undefined.
    const app = new Hono();
    registerUsageRoutes(
      app,
      { concierge: undefined } as unknown as Parameters<typeof registerUsageRoutes>[1],
    );
    const res = await app.request('/api/usage');
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toBe('concierge_not_wired');
  });
});

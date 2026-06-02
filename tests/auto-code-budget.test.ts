import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import {
  BudgetTracker,
  AUTO_CODE_MONTHLY_CAP_USD,
  MONTHLY_CAP_USD,
} from '../src/core/concierge/budget.js';
import { MoSpendLedgerRepository } from '../src/core/concierge/mo-spend-ledger.js';

/**
 * Auto-code Phase 3 — workspace-wide monthly budget tracker tests
 * (sub-ticket 01KQEEE1VSGFMH8T5AEXQENJVW, umbrella
 * 01KQANTZDKW6QH461AK2JN3DCQ).
 *
 * Pins the contract that:
 *   - autoCodeStatus is workspace-wide (no folder filter)
 *   - it sums ONLY the auto-code-* kinds, leaving Mo's $10 cap separate
 *   - withinBudget flips on overage
 *   - authSource flows through verbatim from the caller
 */

interface Ctx {
  handle: DbHandle;
  ledger: MoSpendLedgerRepository;
  tracker: BudgetTracker;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const ledger = new MoSpendLedgerRepository(handle.db);
  return {
    handle,
    ledger,
    tracker: new BudgetTracker(ledger, MONTHLY_CAP_USD),
  };
}

describe('BudgetTracker.autoCodeStatus — workspace-wide auto-code envelope', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns 0 spend / withinBudget=true on a fresh workspace', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    const status = ctx.tracker.autoCodeStatus(50, 'oauth-max', now);
    expect(status.spentMonthUsd).toBe(0);
    expect(status.spentMonthBreakdown['auto-code-fix']).toBe(0);
    expect(status.spentMonthBreakdown['auto-code-review']).toBe(0);
    expect(status.monthlyCapUsd).toBe(50);
    expect(status.withinBudget).toBe(true);
    expect(status.authSource).toBe('oauth-max');
  });

  it('sums fix + review separately + their total reflects spend in window', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    ctx.ledger.record({ kind: 'auto-code-fix', folderId: null,costUsd: 1.5 }, now);
    ctx.ledger.record({ kind: 'auto-code-fix', folderId: null,costUsd: 0.5 }, now);
    ctx.ledger.record({ kind: 'auto-code-review', folderId: null,costUsd: 0.1 }, now);
    const status = ctx.tracker.autoCodeStatus(50, 'oauth-max', now);
    expect(status.spentMonthBreakdown['auto-code-fix']).toBeCloseTo(2.0, 3);
    expect(status.spentMonthBreakdown['auto-code-review']).toBeCloseTo(0.1, 3);
    expect(status.spentMonthUsd).toBeCloseTo(2.1, 3);
  });

  it('flips withinBudget=false when spent exceeds cap', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    ctx.ledger.record({ kind: 'auto-code-fix', folderId: null,costUsd: 51 }, now);
    const status = ctx.tracker.autoCodeStatus(50, 'oauth-max', now);
    expect(status.spentMonthUsd).toBeCloseTo(51, 3);
    expect(status.withinBudget).toBe(false);
  });

  it('does NOT count Mo-side spend (chat/tick/brief/mo_tool) toward auto-code cap', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    ctx.ledger.record({ kind: 'chat', costUsd: 100 }, now);
    ctx.ledger.record({ kind: 'tick', folderId: null,costUsd: 100 }, now);
    ctx.ledger.record({ kind: 'brief', folderId: null,costUsd: 100 }, now);
    ctx.ledger.record({ kind: 'mo_tool', folderId: null,costUsd: 100 }, now);
    const status = ctx.tracker.autoCodeStatus(50, 'oauth-max', now);
    expect(status.spentMonthUsd).toBe(0);
    expect(status.withinBudget).toBe(true);
  });

  it('does NOT count auto-code spend toward Mo orchestration cap', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    ctx.ledger.record({ kind: 'auto-code-fix', folderId: null,costUsd: 100 }, now);
    const moStatus = ctx.tracker.status(now);
    expect(moStatus.spentMonthUsd).toBe(0);
    expect(moStatus.withinBudget).toBe(true);
  });

  it('passes authSource through verbatim — null + oauth-max + api-key all surface', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    expect(ctx.tracker.autoCodeStatus(50, null, now).authSource).toBeNull();
    expect(ctx.tracker.autoCodeStatus(50, 'oauth-max', now).authSource).toBe('oauth-max');
    expect(ctx.tracker.autoCodeStatus(50, 'api-key', now).authSource).toBe('api-key');
  });

  it('respects the monthly window — last-month spend does not count', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    const lastMonth = Date.UTC(2026, 3, 28, 12, 0, 0);
    ctx.ledger.record({ kind: 'auto-code-fix', folderId: null,costUsd: 100 }, lastMonth);
    const status = ctx.tracker.autoCodeStatus(50, 'oauth-max', now);
    expect(status.spentMonthUsd).toBe(0);
    expect(status.withinBudget).toBe(true);
  });

  it('default cap constant matches the design call ($50)', () => {
    expect(AUTO_CODE_MONTHLY_CAP_USD).toBe(50);
  });
});

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { openDb } from '../src/core/db/client.js';
import {
  BudgetTracker,
  ConciergeFolderSettingsRepository,
  ConciergeMessagesRepository,
  ConciergeSessionsRepository,
  MO_BUDGET_SETTING_KEY,
  MoMemoryRepository,
  MoSpendLedgerRepository,
  MONTHLY_CAP_USD,
  readMoMonthlyCap,
} from '../src/core/concierge/index.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { registerProviderSettingsRoutes } from '../src/server/routes/concierge/provider-settings.js';

/**
 * Pin for Slice A (backend) of ticket 01KRNCDK0Y16R8QS8YP2AGSPTF —
 * Limits tab. `PUT /api/concierge/budget` clamps + persists the Mo
 * monthly cap; `BudgetTracker` re-reads the setting on every
 * `status()` call via its callback constructor argument so the new
 * cap is live without a tracker rebuild.
 */
describe('BudgetTracker with cap getter (slice A)', () => {
  it('resolveCap reads fresh from a callback on every status()', () => {
    const { db } = openDb({ path: ':memory:' });
    const ledger = new MoSpendLedgerRepository(db);
    let cap = 10;
    const tracker = new BudgetTracker(ledger, () => cap);
    expect(tracker.status().monthlyCapUsd).toBe(10);
    cap = 25;
    expect(tracker.status().monthlyCapUsd).toBe(25);
  });

  it('readMoMonthlyCap falls back to MONTHLY_CAP_USD when setting unset or malformed', () => {
    const { db } = openDb({ path: ':memory:' });
    const settings = new SettingsRepository(db);
    expect(readMoMonthlyCap(settings)).toBe(MONTHLY_CAP_USD);
    settings.set(MO_BUDGET_SETTING_KEY, 42);
    expect(readMoMonthlyCap(settings)).toBe(42);
    settings.set(MO_BUDGET_SETTING_KEY, '7.5');
    expect(readMoMonthlyCap(settings)).toBe(7.5);
    settings.set(MO_BUDGET_SETTING_KEY, 'banana');
    expect(readMoMonthlyCap(settings)).toBe(MONTHLY_CAP_USD);
    settings.set(MO_BUDGET_SETTING_KEY, -3);
    expect(readMoMonthlyCap(settings)).toBe(MONTHLY_CAP_USD);
  });

  it('cap=0 flips withinBudget false on the first spent dollar (kill-switch)', () => {
    const { db } = openDb({ path: ':memory:' });
    db.prepare(
      `INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, 0, ?)`,
    ).run('fld_1', 'T', Date.now());
    const ledger = new MoSpendLedgerRepository(db);
    const tracker = new BudgetTracker(ledger, () => 0);
    ledger.record({ kind: 'chat', costUsd: 0.001 });
    const status = tracker.status();
    expect(status.monthlyCapUsd).toBe(0);
    expect(status.withinBudget).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Route — minimal stub bag so we can mount registerProviderSettingsRoutes
// in isolation without dragging the full ConciergeBag wiring.
// ---------------------------------------------------------------------

function setup(): { app: Hono; settings: SettingsRepository; ledger: MoSpendLedgerRepository } {
  const { db } = openDb({ path: ':memory:' });
  const settings = new SettingsRepository(db);
  const ledger = new MoSpendLedgerRepository(db);
  const budget = new BudgetTracker(ledger, () => readMoMonthlyCap(settings));
  const concierge = {
    folderSettings: new ConciergeFolderSettingsRepository(db),
    sessions: new ConciergeSessionsRepository(db),
    messages: new ConciergeMessagesRepository(db),
    moSpendLedger: ledger,
    moMemory: new MoMemoryRepository(settings),
    budget,
  };
  const app = new Hono();
  // Pro gate: mark this workspace as Pro so PUT doesn't 402. Stored
  // shape matches `StoredLicense` (verify.ts) — lifetime key so the
  // test isn't time-sensitive.
  settings.set('license', {
    email: 'test@morion.local',
    tier: 'pro',
    sku: 'test',
    issued_at: Date.now(),
    expires_at: null,
  });
  registerProviderSettingsRoutes(
    app,
    { db, settings, concierge } as unknown as Parameters<
      typeof registerProviderSettingsRoutes
    >[1],
  );
  return { app, settings, ledger };
}

describe('PUT /api/concierge/budget — Mo cap (ticket 01KRNCDK0Y16R8QS8YP2AGSPTF)', () => {
  it('persists a valid cap to the settings key + returns fresh status', async () => {
    const { app, settings } = setup();
    const res = await app.request('/api/concierge/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyCapUsd: 25 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.monthlyCapUsd).toBe(25);
    expect(settings.get<number>(MO_BUDGET_SETTING_KEY, -1)).toBe(25);
  });

  it('rejects negative cap with 400 cap_out_of_range', async () => {
    const { app } = setup();
    const res = await app.request('/api/concierge/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyCapUsd: -5 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('cap_out_of_range');
  });

  it('rejects cap above 10× default ($100) with 400', async () => {
    const { app } = setup();
    const res = await app.request('/api/concierge/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyCapUsd: 500 }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts cap=0 as kill-switch (within range)', async () => {
    const { app } = setup();
    const res = await app.request('/api/concierge/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyCapUsd: 0 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.monthlyCapUsd).toBe(0);
  });

  it('coerces stringly-typed numbers (form submission compat)', async () => {
    const { app } = setup();
    const res = await app.request('/api/concierge/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyCapUsd: '15.5' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.monthlyCapUsd).toBe(15.5);
  });
});

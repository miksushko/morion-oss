import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  MoSpendLedgerRepository,
  startOfUtcMonth,
  startOfNextUtcMonth,
} from '../../src/core/concierge/index.js';
import { freshDb } from '../helpers/mo-spend-ledger-setup.js';

describe('MoSpendLedger — record + monthlyTotalUsd', () => {
  let db: Database.Database;
  let ledger: MoSpendLedgerRepository;

  beforeEach(() => {
    db = freshDb();
    ledger = new MoSpendLedgerRepository(db);
  });

  it('record() inserts a row and the total reflects it', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0); // 2026-05-10T12:00Z
    ledger.record({ kind: 'chat', costUsd: 0.42 }, now);
    expect(ledger.monthlyTotalUsd(now)).toBeCloseTo(0.42, 3);
  });

  it('monthlyTotalUsd ignores rows from a different UTC month', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    const prevMonthEnd = startOfUtcMonth(now) - 60 * 60 * 1000;
    ledger.record({ kind: 'tick', folderId: 'fld_1', costUsd: 99 }, prevMonthEnd);
    ledger.record({ kind: 'tick', folderId: 'fld_1', costUsd: 1.5 }, now);
    expect(ledger.monthlyTotalUsd(now)).toBeCloseTo(1.5, 3);
  });

  it('boundary: a row at startOfUtcMonth IS in the window', () => {
    const monthStart = Date.UTC(2026, 4, 1, 0, 0, 0);
    ledger.record({ kind: 'brief', folderId: 'fld_1', costUsd: 0.1 }, monthStart);
    expect(ledger.monthlyTotalUsd(monthStart)).toBeCloseTo(0.1, 3);
  });

  it('boundary: a row 1ms before startOfUtcMonth is NOT in the window', () => {
    const monthStart = Date.UTC(2026, 4, 1, 0, 0, 0);
    ledger.record({ kind: 'brief', folderId: 'fld_1', costUsd: 99 }, monthStart - 1);
    expect(ledger.monthlyTotalUsd(monthStart + 1000)).toBeCloseTo(0, 3);
  });

  it('startOfNextUtcMonth wraps year boundary correctly', () => {
    const dec = Date.UTC(2026, 11, 15, 0, 0, 0); // 2026-12-15
    expect(startOfNextUtcMonth(dec)).toBe(Date.UTC(2027, 0, 1, 0, 0, 0));
  });
});

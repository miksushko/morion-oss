import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MoSpendLedgerRepository } from '../../src/core/concierge/index.js';
import { freshDb } from '../helpers/mo-spend-ledger-setup.js';

describe('MoSpendLedger — dailyTotalUsd (back-compat)', () => {
  let db: Database.Database;
  let ledger: MoSpendLedgerRepository;

  beforeEach(() => {
    db = freshDb();
    ledger = new MoSpendLedgerRepository(db);
  });

  it('counts only today (UTC)', () => {
    const today = Date.UTC(2026, 4, 10, 12, 0, 0);
    const yesterday = today - 24 * 60 * 60 * 1000;
    ledger.record({ kind: 'tick', folderId: 'fld_1', costUsd: 5 }, yesterday);
    ledger.record({ kind: 'tick', folderId: 'fld_1', costUsd: 0.7 }, today);
    expect(ledger.dailyTotalUsd(today + 60_000)).toBeCloseTo(0.7, 3);
  });
});

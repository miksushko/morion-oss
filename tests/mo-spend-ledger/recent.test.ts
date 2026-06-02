import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MoSpendLedgerRepository } from '../../src/core/concierge/index.js';
import { freshDb } from '../helpers/mo-spend-ledger-setup.js';

describe('MoSpendLedger — recent', () => {
  let db: Database.Database;
  let ledger: MoSpendLedgerRepository;

  beforeEach(() => {
    db = freshDb();
    ledger = new MoSpendLedgerRepository(db);
  });

  it('returns rows newest-first, capped to limit', () => {
    const t0 = Date.UTC(2026, 4, 10, 0, 0, 0);
    ledger.record({ kind: 'chat', costUsd: 0.1 }, t0);
    ledger.record({ kind: 'chat', costUsd: 0.2 }, t0 + 1);
    ledger.record({ kind: 'chat', costUsd: 0.3 }, t0 + 2);
    const rows = ledger.recent(2);
    expect(rows.map((r) => r.costUsd)).toEqual([0.3, 0.2]);
  });
});

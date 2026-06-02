import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MoSpendLedgerRepository } from '../../src/core/concierge/index.js';
import { freshDb } from '../helpers/mo-spend-ledger-setup.js';

describe('MoSpendLedger — monthlyBreakdown', () => {
  let db: Database.Database;
  let ledger: MoSpendLedgerRepository;

  beforeEach(() => {
    db = freshDb();
    ledger = new MoSpendLedgerRepository(db);
  });

  it('groups by kind, defaults each missing kind to 0', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    ledger.record({ kind: 'chat', costUsd: 1 }, now);
    ledger.record({ kind: 'chat', costUsd: 0.5 }, now);
    ledger.record({ kind: 'tick', folderId: 'fld_1', costUsd: 0.25 }, now);
    const b = ledger.monthlyBreakdown(now);
    expect(b.chat).toBeCloseTo(1.5, 3);
    expect(b.tick).toBeCloseTo(0.25, 3);
    expect(b.brief).toBe(0);
    expect(b.mo_tool).toBe(0);
    // Slice 2 (ticket 01KRJSTN74FT7VRX6KAA42GGBS, migration 0037) —
    // narrow Mo kinds default to 0 alongside the legacy ones so the
    // tri-split UI doesn't crash on a folder that's never been
    // indexed.
    expect(b.mo_indexing_tier1).toBe(0);
    expect(b.mo_indexing_tier2).toBe(0);
    expect(b.mo_indexing_catalog).toBe(0);
    expect(b.mo_topic_hygiene).toBe(0);
    expect(b.mo_gather).toBe(0);
  });
});

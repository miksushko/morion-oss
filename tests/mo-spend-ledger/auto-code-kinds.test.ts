import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { MoSpendLedgerRepository } from '../../src/core/concierge/index.js';
import { freshDb } from '../helpers/mo-spend-ledger-setup.js';

describe('MoSpendLedger — auto-code kinds (sub-ticket 01KQEEE1VSGFMH8T5AEXQENJVW)', () => {
  let db: Database.Database;
  let ledger: MoSpendLedgerRepository;

  beforeEach(() => {
    db = freshDb();
    ledger = new MoSpendLedgerRepository(db);
  });

  it('migration 0022 accepts auto-code-fix and auto-code-review at the CHECK layer', () => {
    expect(() =>
      ledger.record({ kind: 'auto-code-fix', folderId: 'fld_1', costUsd: 0.42 }),
    ).not.toThrow();
    expect(() =>
      ledger.record({ kind: 'auto-code-review', folderId: 'fld_1', costUsd: 0.08 }),
    ).not.toThrow();
  });

  it('monthlyAutoCodeTotalUsd sums only auto-code-* rows in the current UTC month', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    // Mo orchestration spend — should NOT count toward auto-code total.
    ledger.record({ kind: 'chat', costUsd: 5 }, now);
    ledger.record({ kind: 'tick', folderId: 'fld_1', costUsd: 1 }, now);
    // Auto-code spend in current month — counts.
    ledger.record({ kind: 'auto-code-fix', folderId: 'fld_1', costUsd: 0.5 }, now);
    ledger.record({ kind: 'auto-code-review', folderId: 'fld_1', costUsd: 0.1 }, now);
    // Auto-code from LAST month — should NOT count.
    const lastMonth = Date.UTC(2026, 3, 28, 12, 0, 0);
    ledger.record({ kind: 'auto-code-fix', folderId: 'fld_1', costUsd: 99 }, lastMonth);

    expect(ledger.monthlyAutoCodeTotalUsd(now)).toBeCloseTo(0.6, 3);
  });

  it('monthlyAutoCodeTotalUsd scopes to a folder when folderId is provided', () => {
    // Seed a second folder so the FK is satisfied for fld_2.
    db.prepare(
      `INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, 0, ?)`,
    ).run('fld_2', 'Test 2', Date.now());
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    ledger.record({ kind: 'auto-code-fix', folderId: 'fld_1', costUsd: 0.5 }, now);
    ledger.record({ kind: 'auto-code-fix', folderId: 'fld_2', costUsd: 0.3 }, now);
    expect(ledger.monthlyAutoCodeTotalUsd(now, 'fld_1')).toBeCloseTo(0.5, 3);
    expect(ledger.monthlyAutoCodeTotalUsd(now, 'fld_2')).toBeCloseTo(0.3, 3);
    // Workspace-wide (no folderId) sums both.
    expect(ledger.monthlyAutoCodeTotalUsd(now)).toBeCloseTo(0.8, 3);
  });

  it('monthlyBreakdown surfaces auto-code-fix and auto-code-review as their own keys', () => {
    const now = Date.UTC(2026, 4, 10, 12, 0, 0);
    ledger.record({ kind: 'auto-code-fix', folderId: 'fld_1', costUsd: 0.5 }, now);
    ledger.record({ kind: 'auto-code-review', folderId: 'fld_1', costUsd: 0.1 }, now);
    ledger.record({ kind: 'chat', costUsd: 0.05 }, now);
    const b = ledger.monthlyBreakdown(now);
    expect(b['auto-code-fix']).toBeCloseTo(0.5, 3);
    expect(b['auto-code-review']).toBeCloseTo(0.1, 3);
    expect(b.chat).toBeCloseTo(0.05, 3);
    // Mo-side kinds default to 0 when unused — invariant from the
    // pre-auto-code era stays.
    expect(b.tick).toBe(0);
  });
});

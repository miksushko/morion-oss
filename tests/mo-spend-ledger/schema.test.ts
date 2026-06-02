import { describe, it, expect } from 'vitest';
import { MoSpendLedgerRepository } from '../../src/core/concierge/index.js';
import { freshDb } from '../helpers/mo-spend-ledger-setup.js';

describe('MoSpendLedger — schema constraints', () => {
  it('rejects negative costUsd at the DB level', () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO mo_spend_ledger (id, kind, folder_id, cost_usd, created_at)
           VALUES (?, ?, NULL, ?, ?)`,
        )
        .run('id1', 'chat', -0.01, Date.now()),
    ).toThrow(/CHECK constraint|cost_usd/);
  });

  it('rejects unknown kind at the DB level', () => {
    const db = freshDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO mo_spend_ledger (id, kind, folder_id, cost_usd, created_at)
           VALUES (?, ?, NULL, ?, ?)`,
        )
        .run('id1', 'bogus_kind', 1, Date.now()),
    ).toThrow(/CHECK constraint|kind/);
  });

  it('folder_id ON DELETE SET NULL keeps the spend row when its folder is dropped', () => {
    const db = freshDb();
    const ledger = new MoSpendLedgerRepository(db);
    ledger.record({ kind: 'tick', folderId: 'fld_1', costUsd: 0.5 });
    db.prepare('DELETE FROM folders WHERE id = ?').run('fld_1');
    const rows = ledger.recent(10);
    expect(rows.length).toBe(1);
    expect(rows[0].folderId).toBeNull();
    expect(rows[0].costUsd).toBeCloseTo(0.5, 3);
  });
});

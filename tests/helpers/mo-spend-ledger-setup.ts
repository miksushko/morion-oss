import type Database from 'better-sqlite3';
import { openDb } from '../../src/core/db/client.js';

/**
 * Shared fixture for the MoSpendLedger unit-test suite.
 * Extracted from tests/mo-spend-ledger.test.ts during the 2026-05-16
 * split (Morion umbrella ticket 01KRQSBM19X6BA3SKR8CYFX0H0).
 *
 * Seeds one folder (`fld_1`) so FK on mo_spend_ledger.folder_id is
 * satisfied for any test that records a folder-scoped row.
 */
export function freshDb(): Database.Database {
  const { db } = openDb({ path: ':memory:' });
  db.prepare(
    `INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, 0, ?)`,
  ).run('fld_1', 'Test', Date.now());
  return db;
}

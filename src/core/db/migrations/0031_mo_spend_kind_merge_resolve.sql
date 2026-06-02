-- Auto-code AI merge-conflict resolver (sister to 0022 auto-code-fix /
-- auto-code-review extension).
--
-- The ConflictResolverModal's "Try AI auto-resolve" button calls a
-- frontier model (deepseek-v4-pro primary, claude-sonnet-4 fallback)
-- with the conflict-marked file content + ticket context. Each call
-- spends real money — needs to land in the same ledger the rest of
-- auto-code spend uses so the workspace cap covers it AND the
-- per-kind breakdown can show "auto-code-merge-resolve $0.15" beside
-- fix / review.
--
-- SQLite doesn't support ALTER COLUMN modifying CHECK constraints, so
-- we do the table-recreate dance per migration 0022's pattern.

PRAGMA foreign_keys=OFF;

CREATE TABLE mo_spend_ledger_new (
  id          TEXT NOT NULL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('chat','tick','brief','mo_tool','auto-code-fix','auto-code-review','auto-code-merge-resolve')),
  -- ON DELETE SET NULL inherited from 0016 / 0022. Folder rows can be
  -- soft-deleted (trash) and later hard-purged; we keep the spend row
  -- for monthly accounting but unlink the folder reference.
  folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  cost_usd    REAL NOT NULL CHECK (cost_usd >= 0),
  created_at  INTEGER NOT NULL
);

INSERT INTO mo_spend_ledger_new (id, kind, folder_id, cost_usd, created_at)
  SELECT id, kind, folder_id, cost_usd, created_at FROM mo_spend_ledger;

DROP TABLE mo_spend_ledger;
ALTER TABLE mo_spend_ledger_new RENAME TO mo_spend_ledger;

CREATE INDEX IF NOT EXISTS idx_mo_spend_ledger_created_at
  ON mo_spend_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_mo_spend_ledger_kind_created_at
  ON mo_spend_ledger(kind, created_at);

PRAGMA foreign_keys=ON;

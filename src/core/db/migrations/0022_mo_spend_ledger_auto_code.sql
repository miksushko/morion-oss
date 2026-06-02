-- Auto-code Phase 3 — extend mo_spend_ledger.kind to include auto-code spawn
-- spend (sub-ticket 01KQEEE1VSGFMH8T5AEXQENJVW, umbrella 01KQANTZDKW6QH461AK2JN3DCQ).
--
-- The Mo spend ledger originally enumerated 4 kinds via a CHECK
-- constraint: 'chat' / 'tick' / 'brief' / 'mo_tool'. The auto-code loop
-- spawns claude/codex sessions whose costs need their own taxonomy so
-- the per-kind monthly breakdown can show "auto-code-fix $4.20 ·
-- auto-code-review $0.80 · chat $0.50" instead of conflating them with
-- chat. Cap enforcement is then per-bucket (Mo: $10, auto-code: $50)
-- — different budgets, different envelopes.
--
-- SQLite doesn't support ALTER COLUMN modifying CHECK constraints, so
-- we recreate the table. The data set is small (~thousands of rows /
-- month even for heavy users) so the copy is cheap.
--
-- Two new kinds:
--   - auto-code-fix     spawned by orchestrator's claude-launcher fix path
--   - auto-code-review  spawned by codex-launcher review path
--                       (codex 0.1.x always reports $0 since cost is
--                        dashboard-side; claude-fallback review reports
--                        real numbers from --output-format json)

PRAGMA foreign_keys = OFF;

CREATE TABLE mo_spend_ledger_new (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('chat','tick','brief','mo_tool','auto-code-fix','auto-code-review')),
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

-- Index the kind column too — auto-code's monthly-total query filters
-- by `kind LIKE 'auto-code-%'` which is a covering range on the kind
-- string. Without this the budget-cap check on every claim does a
-- full-month range scan + per-row substring filter; with it the check
-- is O(log n) for the kind subset.
CREATE INDEX IF NOT EXISTS idx_mo_spend_ledger_kind_created_at
  ON mo_spend_ledger(kind, created_at);

PRAGMA foreign_keys = ON;

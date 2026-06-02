-- Mo Context Broker spend ledger — single source of truth for monthly
-- per-user budget enforcement. Reverses the lesson logged in
-- `01KQ1H556RFFKD7WGZE77MEVFQ`: previously `BudgetTracker` summed only
-- `concierge_messages.cost_usd`, missing headless tick + brief digest
-- spend (and double-counting chat tool-loop turns). Result: the $5/day
-- soft cap was meaningless because most Mo work bypassed it.
--
-- New design: every billed Mo provider call writes exactly one row
-- here. `BudgetTracker` reads `SUM(cost_usd) WHERE created_at >= start
-- of UTC month`. Append-only — rows are never updated or deleted, so
-- the ledger doubles as a cheap audit trail of what Mo cost the user.
--
-- Per-user semantics: this ledger is workspace-local (one DB per
-- install). For the future Worker LLM proxy, per-user enforcement
-- happens at the HTTP edge using license_email — keep that enforcement
-- separate from this local ledger so the Worker can degrade gracefully
-- if the desktop app is offline.
--
-- `kind` discriminates the source for dashboards / debugging:
--   chat     — interactive `/concierge/sessions/.../messages` turn
--   tick     — autonomous scheduler tick OR manual Concierge run
--   brief    — Project Brief digest pass
--   mo_tool  — Phase 2b+ `mo_*` LLM-tier tool call (e.g. `mo_report_result`)
--
-- `folder_id` is nullable — chat turns are not folder-scoped today,
-- and Phase 2b+ workspace-scoped operations may also lack a folder.
-- ON DELETE SET NULL: if the user deletes a folder, its ledger rows
-- stay so the monthly total stays accurate.

CREATE TABLE IF NOT EXISTS mo_spend_ledger (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('chat','tick','brief','mo_tool')),
  folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  cost_usd    REAL NOT NULL CHECK (cost_usd >= 0),
  created_at  INTEGER NOT NULL
);

-- The hot read on this table is `SUM(cost_usd) WHERE created_at >= ?`
-- (start-of-UTC-month). Index on created_at makes that a range scan
-- rather than a full table scan. Spending grows ~daily so the table
-- stays small (low thousands of rows / month even for heavy users),
-- but the index protects us if a debugging user enumerates by month.
CREATE INDEX IF NOT EXISTS idx_mo_spend_ledger_created_at
  ON mo_spend_ledger(created_at);

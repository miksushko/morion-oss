-- Usage stats — kind enum split (ticket 01KRJSTN74FT7VRX6KAA42GGBS, slice 2).
--
-- The legacy `mo_tool` bucket conflates everything from indexing
-- background work to user-initiated writes (mo_record / mo_remember)
-- to deep-research gather (mo_get_context / mo_ask). That makes the
-- Usage dashboard useless for the main optimisation target — "how
-- much of my budget goes to background indexing vs my actual chats".
--
-- Splitting into five narrow kinds so the dashboard can render a
-- meaningful per-kind row + the Interactive / Background / Auto-code
-- tri-split that's the main user-side decision aid:
--
--   mo_indexing_tier1     — per-note metadata classifier (background)
--   mo_indexing_tier2     — per-cluster aggregator regen (background)
--   mo_indexing_catalog   — Tier 2.5 catalog writer (background)
--   mo_topic_hygiene      — cleanup proposer (background)
--   mo_gather             — mo_get_context / mo_ask deep reads (user)
--
-- Legacy `mo_tool` STAYS — it's the right bucket for `mo_record` /
-- `mo_remember` / `mo_forget` and for auto-code workflow Mo-decision
-- calls (mo-stage-dispatcher / mo-messenger-dispatcher). It also
-- keeps existing historical rows from the pre-split era valid.
--
-- Migration approach: SQLite doesn't ALTER COLUMN modifying CHECK,
-- so we follow the table-recreate pattern from 0022 / 0031. All
-- column types AND the migration 0036 token columns must be
-- preserved.

PRAGMA foreign_keys=OFF;

CREATE TABLE mo_spend_ledger_new (
  id                  TEXT NOT NULL PRIMARY KEY,
  kind                TEXT NOT NULL CHECK (kind IN (
                        'chat','tick','brief','mo_tool',
                        'auto-code-fix','auto-code-review','auto-code-merge-resolve',
                        'mo_indexing_tier1','mo_indexing_tier2','mo_indexing_catalog',
                        'mo_topic_hygiene','mo_gather'
                      )),
  folder_id           TEXT REFERENCES folders(id) ON DELETE SET NULL,
  cost_usd            REAL NOT NULL CHECK (cost_usd >= 0),
  created_at          INTEGER NOT NULL,
  provider            TEXT,
  model               TEXT,
  prompt_tokens       INTEGER,
  completion_tokens   INTEGER,
  cached_tokens       INTEGER,
  cache_write_tokens  INTEGER,
  reasoning_tokens    INTEGER
);

INSERT INTO mo_spend_ledger_new (
  id, kind, folder_id, cost_usd, created_at,
  provider, model, prompt_tokens, completion_tokens,
  cached_tokens, cache_write_tokens, reasoning_tokens
)
SELECT
  id, kind, folder_id, cost_usd, created_at,
  provider, model, prompt_tokens, completion_tokens,
  cached_tokens, cache_write_tokens, reasoning_tokens
FROM mo_spend_ledger;

DROP TABLE mo_spend_ledger;
ALTER TABLE mo_spend_ledger_new RENAME TO mo_spend_ledger;

-- Re-create every index the prior migrations defined. Order is the
-- same as their introduction (0016 base, 0022 kind+created_at, 0036
-- provider/model). Skipping any would silently degrade aggregator
-- queries.
CREATE INDEX IF NOT EXISTS idx_mo_spend_ledger_created_at
  ON mo_spend_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_mo_spend_ledger_kind_created_at
  ON mo_spend_ledger(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_mo_spend_ledger_provider_created_at
  ON mo_spend_ledger(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_mo_spend_ledger_model_created_at
  ON mo_spend_ledger(model, created_at);

PRAGMA foreign_keys=ON;

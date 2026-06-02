-- Usage stats — billed-vs-included separation (ticket
-- 01KRJSTN74FT7VRX6KAA42GGBS, slice 11). Mirrors the GitHub Actions /
-- Anthropic console pattern: show metered spend (what the API price
-- WOULD be) alongside included spend (what a subscription covered),
-- so a Claude OAuth Max user can see "auto-code spent $50 equivalent
-- but $0 real" instead of a misleading cap-progress.
--
-- Column values:
--   'subscription' — equivalent API price; not actually charged
--                    (Claude OAuth Max session driving an auto-code
--                    fix / review / merge-resolve).
--   'api'          — real API-key call where the dollar amount left
--                    the user's account. Reserved for future explicit
--                    stamping; pre-slice-11 plumb leaves Mo rows as
--                    NULL (see below).
--   NULL           — auth mode not captured. Treated as "metered" in
--                    SQL filters (i.e. counted toward the real-spend
--                    cap). Pre-migration rows + Mo provider calls
--                    that don't surface an auth mode hint.
--
-- Cap semantics (enforced by `BudgetTracker.autoCodeStatus` in
-- application code, NOT in SQL):
--   - Real-spend cap counts only rows where auth_mode IS NULL OR
--     auth_mode = 'api'. A Max-plan user can run unlimited fixes
--     without sliding the cap.
--   - Included spend is summed separately so the UI can render the
--     "$N covered by subscription" line.
--
-- Additive migration — no table-recreate dance needed since adding
-- a TEXT column with a default doesn't touch the existing CHECK
-- constraint on `kind`. NULL is the safe default for legacy rows.

ALTER TABLE mo_spend_ledger ADD COLUMN auth_mode TEXT;

-- Composite index for the auto-code cap progress query, which sums
-- cost_usd over auth_mode = 'api' OR NULL within the current UTC
-- month. The existing kind+created_at index doesn't help for the
-- auth-mode dimension — this one keeps the cap-status hot path O(log n).
CREATE INDEX IF NOT EXISTS idx_mo_spend_ledger_auth_mode_created_at
  ON mo_spend_ledger(auth_mode, created_at);

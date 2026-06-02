-- Phase 6 V2 rollback (Morion ticket 01KRG02E2SV2F9F3PZ6TPDDCNA).
--
-- The DB-backed polling design from migration 0033 was the wrong
-- shape: it implied the cli_agent BLOCKS on a long-running MCP tool
-- call while the user replies in chat. The user's clarification
-- (architecture review 2026-05-13) is that the agent should INSTEAD
-- end its stage with the question in its natural output, hand
-- control back to Mo (the next mo_stage), and let Mo decide whether
-- to answer from context, ask the user, or route elsewhere.
--
-- That re-architecture lives in subsequent commits (B / C of this
-- batch). Migration 0033's table + indexes are now dead weight —
-- drop them so future schema audits aren't surprised by an orphan
-- table. SQLite migrations are forward-only; this DROP is a clean
-- removal, not a backout of 0033 (which has already shipped to
-- main and may have run on installs).

DROP INDEX IF EXISTS idx_auto_code_clarifications_run;
DROP INDEX IF EXISTS idx_auto_code_clarifications_correlation;
DROP INDEX IF EXISTS idx_auto_code_clarifications_active;
DROP TABLE IF EXISTS auto_code_clarifications;

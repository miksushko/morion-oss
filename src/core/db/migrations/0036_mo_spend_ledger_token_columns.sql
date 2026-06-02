-- Usage stats — LLM consumption dashboard (ticket 01KRJSTN74FT7VRX6KAA42GGBS).
--
-- Enrich mo_spend_ledger rows with provider/model identity + token
-- counts so Settings → Usage can break spend down by provider, model,
-- and feature (interactive / background / auto-code). Every column is
-- nullable: existing rows pre-migration keep NULL, new rows fill what
-- the provider returned. This decouples the schema migration from the
-- provider-parser changes (Slice 3) — backfill happens naturally as
-- new calls land.
--
-- Why these specific columns:
--   provider              — backend identity (openrouter|openai|
--                           anthropic|groq|ollama). Lets the UI break
--                           down spend by upstream so a user on
--                           multiple backends can see per-vendor cost.
--   model                 — resolved model id echo (the `response.model`
--                           field, NOT the requested model — providers
--                           sometimes substitute on fallback).
--   prompt_tokens         — input tokens billed.
--   completion_tokens     — output tokens billed.
--   cached_tokens         — subset of prompt_tokens that hit the
--                           provider's prompt cache. Drives the
--                           "cache hit %" metric per-kind so the user
--                           can spot misconfigured caching.
--   cache_write_tokens    — cost of writing to the cache (separate
--                           billing line on Anthropic, sometimes OAI).
--   reasoning_tokens      — hidden completion tokens billed for o1/o3/
--                           gpt-5/DeepSeek-R1 reasoning. Not visible
--                           in completion_tokens; explains "why is
--                           this short answer so expensive".
--
-- ADD COLUMN is forward-compatible — no table-recreate dance. Old
-- code paths that don't yet write these fields will keep producing
-- rows with NULL in the new columns; new aggregator queries treat
-- NULL token columns as "data not captured" rather than 0 so the UI
-- can differentiate "no calls of this kind" from "calls happened but
-- pre-Slice-3".

ALTER TABLE mo_spend_ledger ADD COLUMN provider TEXT;
ALTER TABLE mo_spend_ledger ADD COLUMN model TEXT;
ALTER TABLE mo_spend_ledger ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE mo_spend_ledger ADD COLUMN completion_tokens INTEGER;
ALTER TABLE mo_spend_ledger ADD COLUMN cached_tokens INTEGER;
ALTER TABLE mo_spend_ledger ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE mo_spend_ledger ADD COLUMN reasoning_tokens INTEGER;

-- The new per-provider / per-model breakdown aggregator does
-- GROUP BY provider / model with a created_at lower bound. Composite
-- indexes accelerate that without bloating writes (ledger is append-
-- only and provider/model are stable per-row so no index updates on
-- the hot path).
CREATE INDEX IF NOT EXISTS idx_mo_spend_ledger_provider_created_at
  ON mo_spend_ledger(provider, created_at);
CREATE INDEX IF NOT EXISTS idx_mo_spend_ledger_model_created_at
  ON mo_spend_ledger(model, created_at);

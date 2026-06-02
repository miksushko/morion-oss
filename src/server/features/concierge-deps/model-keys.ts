/**
 * Per-backend setting-key getters. Each function builds the canonical
 * settings-table key for a (backend, pipeline) tuple. Per-backend so a
 * user who switches OpenRouter → Groq doesn't carry an OpenRouter
 * slug into Groq (would 404). Empty stored value means "use whatever
 * fallback the resolver picks" — UI placeholders show recommended
 * model ids as typing-aids only, NOT hardcoded defaults (CLAUDE.md
 * "no hardcoded model defaults" rule).
 *
 * Pipelines covered:
 *   - topicHygiene (proposer + fallback)
 *   - tier1 / tier2 indexing pipeline (per Phase 3.5+ of epic
 *     01KPGWTJCWVBQCCSQ8NGSB19KQ)
 *   - gather (subagent / synthesis / synthesis-thorough — Phase 8
 *     context restructure ticket 01KQFQ1RJV7EH0X3WF2H1A476J)
 *   - merge-resolver (primary + fallback)
 */
import type { ConciergeBackend } from './types.js';

/** Workspace setting key for the topic-hygiene model. */
export function topicHygieneModelKey(backend: ConciergeBackend): string {
  return `concierge.${backend}_topic_hygiene_model`;
}

export function topicHygieneFallbackKey(backend: ConciergeBackend): string {
  return `concierge.${backend}_topic_hygiene_model_fallback`;
}

/**
 * Per-backend tier1 / tier2 indexing-pipeline model overrides
 * (Phase 3.5+ of epic 01KPGWTJCWVBQCCSQ8NGSB19KQ).
 *
 * Tier 1 = per-note metadata (summary + keywords) — runs on every
 *           note when indexing is enabled. High volume; needs to be
 *           cheap.
 * Tier 2 = cluster aggregator + Tier 2.5 catalog — fewer calls but
 *           handles heavier synthesis.
 */
export function tier1ModelKey(backend: ConciergeBackend): string {
  return `concierge.${backend}_tier1_model`;
}

export function tier1FallbackKey(backend: ConciergeBackend): string {
  return `concierge.${backend}_tier1_model_fallback`;
}

export function tier2ModelKey(backend: ConciergeBackend): string {
  return `concierge.${backend}_tier2_model`;
}

export function tier2FallbackKey(backend: ConciergeBackend): string {
  return `concierge.${backend}_tier2_model_fallback`;
}

/**
 * Per-backend setting keys for the deep-context-gather pipeline. Same
 * shape as `topicHygieneModelKey` — empty stored value means "fall
 * back to indexing tier1/tier2 model" (so the engine works out of the
 * box on any folder where Mo Indexing is already configured).
 */
export function gatherSubagentModelKey(backend: ConciergeBackend): string {
  return `concierge.${backend}_gather_subagent_model`;
}

export function gatherSynthesisModelKey(backend: ConciergeBackend): string {
  return `concierge.${backend}_gather_synthesis_model`;
}

export function gatherSynthesisThoroughModelKey(
  backend: ConciergeBackend,
): string {
  return `concierge.${backend}_gather_synthesis_model_thorough`;
}

/**
 * Per-backend model settings for the AI merge-conflict resolver
 * (ConflictResolverModal "Try AI auto-resolve" button). Primary is
 * the heavy model that gets the job done; fallback fires when primary
 * fails (rate limit / refusal / malformed output / regex-leftover-
 * marker rejection).
 */
export function mergeResolverModelKey(backend: ConciergeBackend): string {
  return `concierge.${backend}_merge_resolver_model`;
}

export function mergeResolverFallbackKey(backend: ConciergeBackend): string {
  return `concierge.${backend}_merge_resolver_model_fallback`;
}

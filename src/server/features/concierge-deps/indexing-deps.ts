/**
 * Indexing + topic-hygiene + gather + merge-resolver dep factories.
 * Each `build*` / `resolve*` function takes a `ConciergeDepsHost` and
 * returns the deps object the corresponding subsystem needs.
 *
 * The legacy `buildConciergeEngineDeps` factory was deleted alongside
 * the autonomous Mo agent (ticket `01KQVA65TJ2VCY8VCKH9N5F6W8`,
 * 2026-05-05). The scheduler now only drives Mo Indexing + topic-
 * hygiene — both factories live below. Provider routing for chat /
 * `mo_ask` / `mo_get_context` lives in `provider-routing.ts` and
 * `resolveGatherProvider` below.
 */
import {
  MO_INDEXING_DEFAULTS_BACKEND,
  MO_INDEXING_TIER1_FALLBACK,
  MO_INDEXING_TIER1_MODEL,
  MO_INDEXING_TIER2_FALLBACK,
  MO_INDEXING_TIER2_MODEL,
  type MoIndexingProvider,
  type MoIndexingTickDeps,
} from '../../../core/concierge/index.js';
import {
  BACKEND_CONFIGS,
  BACKEND_FACTORIES,
  readEnvFirst,
} from './backend-configs.js';
import {
  gatherSubagentModelKey,
  gatherSynthesisModelKey,
  gatherSynthesisThoroughModelKey,
  mergeResolverFallbackKey,
  mergeResolverModelKey,
  tier1FallbackKey,
  tier1ModelKey,
  tier2FallbackKey,
  tier2ModelKey,
  topicHygieneFallbackKey,
  topicHygieneModelKey,
  workflowBuilderFallbackKey,
  workflowBuilderModelKey,
} from './model-keys.js';
import { readBackend } from './provider-routing.js';
import type {
  ConciergeDepsHost,
  GatherModels,
  MergeResolverModels,
  WorkflowBuilderModels,
} from './types.js';

/**
 * Mo Indexing Redesign Phase 2c — factory for the periodic indexing
 * tick wired into `ConciergeScheduler`.
 *
 * The deps object is built ONCE at startup; the `resolveProvider`
 * closure is re-evaluated per scheduler tick so toggling backend or
 * adding the OpenRouter key takes effect on the next pass without
 * server restart.
 *
 * Backend gate: the tick runs on ANY configured backend (openrouter /
 * openai / anthropic / groq / ollama). It needs (a) a key for the
 * active backend — except ollama, which is keyless local inference —
 * and (b) usable tier1 + tier2 model ids. OpenRouter ships curated
 * built-in model defaults (`MO_INDEXING_DEFAULTS_BACKEND`); every other
 * backend requires the user to set tier1 + tier2 explicitly in Settings
 * → Mo → pipeline models (per the "no hardcoded model defaults" rule —
 * vendor ids go stale, and OpenRouter's namespaced ids 404 on direct
 * APIs). Missing key or missing required models → `resolveProvider()`
 * returns null → tick logs `gated_off` and bails.
 */
export function buildMoIndexingDeps(host: ConciergeDepsHost): MoIndexingTickDeps {
  // Production wiring always populates these via runtime.ts; the bag
  // fields are typed optional only so MCP tools / tests that build
  // their own host-shape don't need to thread them through.
  const meta = host.concierge.moMetadata;
  const clusters = host.concierge.moClusters;
  const metaQueue = host.concierge.moMetadataQueue;
  const clusterQueue = host.concierge.moClusterQueue;
  if (!meta || !clusters || !metaQueue || !clusterQueue) {
    throw new Error(
      'buildMoIndexingDeps called against a ConciergeBag missing the indexing repos — ' +
        'production wiring must populate moMetadata / moClusters / moMetadataQueue / moClusterQueue',
    );
  }
  return {
    db: host.db,
    notes: host.notes,
    folders: host.folders,
    workspaceSettings: host.settings,
    folderSettings: host.concierge.folderSettings,
    metaRepo: meta,
    clustersRepo: clusters,
    metadataQueue: metaQueue,
    clusterQueue,
    budget: host.concierge.budget,
    // Phase 2 wiring — both passed if the host has them. When either
    // is missing the indexing tick + Tier 1 worker silently skip the
    // vec write (production always supplies; tests that don't need
    // semantic ranking can omit either to keep the fixture slim).
    vec: host.concierge.moMetadataVec,
    embeddings: host.embeddings,
    resolveProvider: () => resolveMoIndexingProvider(host),
  };
}

/** Resolved tier1 / tier2 model picks (+ fallbacks) for a backend.
 *  Empty fallback string = single-attempt mode (no retry). */
interface ResolvedTierModels {
  tier1Model: string;
  tier1FallbackModel: string;
  tier2Model: string;
  tier2FallbackModel: string;
}

/**
 * Resolve tier1 / tier2 model ids for the active backend from settings.
 *
 * OpenRouter (`MO_INDEXING_DEFAULTS_BACKEND`) ships curated built-in
 * defaults so it works with zero configuration. Every other backend has
 * NO hardcoded default (vendor ids go stale + OpenRouter's namespaced
 * ids 404 on direct APIs) — tier1 + tier2 MUST be set explicitly. When
 * either is missing on a non-OpenRouter backend this returns null, which
 * propagates up as `mo_provider_unconfigured`.
 */
function resolveTierModels(
  host: ConciergeDepsHost,
  backend: ReturnType<typeof readBackend>,
): ResolvedTierModels | null {
  const isDefaultsBackend = backend === MO_INDEXING_DEFAULTS_BACKEND;
  const get = (key: string): string =>
    host.settings.get<string>(key, '').trim();
  const tier1Model =
    get(tier1ModelKey(backend)) || (isDefaultsBackend ? MO_INDEXING_TIER1_MODEL : '');
  const tier2Model =
    get(tier2ModelKey(backend)) || (isDefaultsBackend ? MO_INDEXING_TIER2_MODEL : '');
  if (!tier1Model || !tier2Model) return null;
  const tier1FallbackModel =
    get(tier1FallbackKey(backend)) ||
    (isDefaultsBackend ? MO_INDEXING_TIER1_FALLBACK : '');
  const tier2FallbackModel =
    get(tier2FallbackKey(backend)) ||
    (isDefaultsBackend ? MO_INDEXING_TIER2_FALLBACK : '');
  return { tier1Model, tier1FallbackModel, tier2Model, tier2FallbackModel };
}

export function resolveMoIndexingProvider(
  host: ConciergeDepsHost,
): MoIndexingProvider | null {
  // Note: the chat path's `providerOverride` escape hatch is
  // INTENTIONALLY not consulted here. The indexing tick is independent
  // of chat — tests that need indexing to fire wire it directly via
  // `runMoIndexingTick` with a stub `resolveProvider` (see
  // tests/mo-indexing-tick.test.ts). This keeps start-http-scheduler
  // tests stable: their CountingProvider only counts engine ticks.
  const backend = readBackend(host);
  const cfg = BACKEND_CONFIGS[backend];
  const storedKey = host.settings.get<string>(cfg.keySetting, '');
  const envKey = readEnvFirst(cfg.envKeys);
  const key = storedKey || envKey;
  // Ollama is keyless local inference — its `keySetting` is a base URL
  // that defaults to 127.0.0.1:11434 when blank. Every other backend
  // needs an API key.
  if (backend !== 'ollama' && !key) return null;
  try {
    const tiers = resolveTierModels(host, backend);
    if (!tiers) return null;
    // Topic-hygiene proposer model: separate per-backend setting.
    // Empty / unset → falls back to the resolved tier2 model (honoring
    // the user's tier2 override when set).
    const storedHygiene = host.settings
      .get<string>(topicHygieneModelKey(backend), '')
      .trim();
    const storedHygieneFallback = host.settings
      .get<string>(topicHygieneFallbackKey(backend), '')
      .trim();
    const topicHygieneModel = storedHygiene || tiers.tier2Model;
    const topicHygieneFallbackModel = storedHygieneFallback
      ? storedHygieneFallback
      : storedHygiene
      ? tiers.tier2Model
      : tiers.tier2FallbackModel;
    return {
      provider: BACKEND_FACTORIES[backend](key),
      tier1Model: tiers.tier1Model,
      tier1FallbackModel: tiers.tier1FallbackModel || null,
      tier2Model: tiers.tier2Model,
      tier2FallbackModel: tiers.tier2FallbackModel || null,
      topicHygieneModel,
      topicHygieneFallbackModel: topicHygieneFallbackModel || null,
    };
  } catch {
    return null;
  }
}

/**
 * User-initiated gather pipeline (mo_ask, mo_get_context) provider
 * resolver. Honors `concierge.providerOverride` first — same shape as
 * the chat path's `readProviderModel` — so test harnesses can inject
 * a stub provider without configuring real OpenRouter keys. Falls
 * back to `resolveMoIndexingProvider(host)` for production paths.
 *
 * Distinct from `resolveMoIndexingProvider` because the indexing tick
 * INTENTIONALLY ignores providerOverride (background work shouldn't
 * route through whatever stub the chat tests injected).
 */
export function resolveGatherProvider(
  host: ConciergeDepsHost,
): MoIndexingProvider | null {
  const override = host.concierge.providerOverride;
  if (override) {
    // Override doesn't change the model picks — those still come from
    // settings, which `resolveMoIndexingProvider` would also produce.
    // Fall back to the indexing-tier defaults when the indexing
    // resolver returns null (test paths without OpenRouter configured).
    const real = resolveMoIndexingProvider(host);
    if (real) return { ...real, provider: override };
    return {
      provider: override,
      tier1Model: MO_INDEXING_TIER1_MODEL,
      tier1FallbackModel: MO_INDEXING_TIER1_FALLBACK,
      tier2Model: MO_INDEXING_TIER2_MODEL,
      tier2FallbackModel: MO_INDEXING_TIER2_FALLBACK,
      topicHygieneModel: MO_INDEXING_TIER2_MODEL,
      topicHygieneFallbackModel: MO_INDEXING_TIER2_FALLBACK,
    };
  }
  return resolveMoIndexingProvider(host);
}

/** Resolve per-backend merge-resolver model picks from settings.
 *  Resolves on any configured backend (tier2 must be resolvable — see
 *  `resolveTierModels`); test paths inject `providerOverride` and bypass
 *  model resolution with echoed defaults.
 *
 *  Empty primary → falls back to the resolved tier2 model (cheap, often
 *  "good enough" for trivial conflicts). Empty fallback → single-attempt
 *  mode (no retry on primary failure). */
export function resolveMergeResolverModels(
  host: ConciergeDepsHost,
): MergeResolverModels | null {
  const backend = readBackend(host);
  // Test path: stub provider injected on a backend without curated
  // defaults — echo the tier2 placeholder so the call shape matches prod.
  if (backend !== MO_INDEXING_DEFAULTS_BACKEND && host.concierge.providerOverride) {
    return { primaryModel: MO_INDEXING_TIER2_MODEL, fallbackModel: '' };
  }
  const tiers = resolveTierModels(host, backend);
  if (!tiers) return null;
  const primary = host.settings
    .get<string>(mergeResolverModelKey(backend), '')
    .trim();
  const fallback = host.settings
    .get<string>(mergeResolverFallbackKey(backend), '')
    .trim();
  return {
    primaryModel: primary || tiers.tier2Model,
    fallbackModel: fallback,
  };
}

/** Resolve per-backend workflow-builder model picks from settings —
 *  the drafting model behind `mo_build_workflow` (Mo Workflows
 *  epic). Same contract as the merge resolver:
 *  empty primary → resolved tier2 (works out of the box on any
 *  configured backend); empty fallback → single-attempt mode. */
export function resolveWorkflowBuilderModels(
  host: ConciergeDepsHost,
): WorkflowBuilderModels | null {
  const backend = readBackend(host);
  // Test path: stub provider injected on a backend without curated
  // defaults — echo the tier2 placeholder so the call shape matches prod.
  if (backend !== MO_INDEXING_DEFAULTS_BACKEND && host.concierge.providerOverride) {
    return { primaryModel: MO_INDEXING_TIER2_MODEL, fallbackModel: '' };
  }
  const tiers = resolveTierModels(host, backend);
  if (!tiers) return null;
  const primary = host.settings
    .get<string>(workflowBuilderModelKey(backend), '')
    .trim();
  const fallback = host.settings
    .get<string>(workflowBuilderFallbackKey(backend), '')
    .trim();
  return {
    primaryModel: primary || tiers.tier2Model,
    fallbackModel: fallback,
  };
}

/**
 * Resolve the gather pipeline's model picks from settings. Each falls
 * back to the resolved indexing tier1/tier2 picks when unset, so the
 * engine works on any folder that's already Mo-indexed without extra
 * configuration.
 *
 * Resolves on any configured backend. OpenRouter has built-in tier
 * defaults; other backends require tier1 + tier2 to be set (otherwise
 * `resolveTierModels` returns null → `mo_provider_unconfigured`). Test
 * paths inject `providerOverride` and bypass model resolution; the model
 * strings are echoed verbatim to the stub so they can be any placeholder.
 */
export function resolveGatherModels(host: ConciergeDepsHost): GatherModels | null {
  const backend = readBackend(host);
  // Test path: stub provider doesn't care which model id we hand it.
  // Echo the indexing tier defaults so the call shape stays identical.
  if (backend !== MO_INDEXING_DEFAULTS_BACKEND && host.concierge.providerOverride) {
    return {
      subagentModel: MO_INDEXING_TIER1_MODEL,
      synthesisModel: MO_INDEXING_TIER2_MODEL,
      synthesisThoroughModel: MO_INDEXING_TIER2_MODEL,
    };
  }

  const tiers = resolveTierModels(host, backend);
  if (!tiers) return null;

  const subagent = host.settings
    .get<string>(gatherSubagentModelKey(backend), '')
    .trim();
  const synth = host.settings
    .get<string>(gatherSynthesisModelKey(backend), '')
    .trim();
  const synthThorough = host.settings
    .get<string>(gatherSynthesisThoroughModelKey(backend), '')
    .trim();

  return {
    subagentModel: subagent || tiers.tier1Model,
    synthesisModel: synth || tiers.tier2Model,
    synthesisThoroughModel: synthThorough || synth || tiers.tier2Model,
  };
}

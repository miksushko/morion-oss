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
  MO_INDEXING_REQUIRED_BACKEND,
  MO_INDEXING_TIER1_FALLBACK,
  MO_INDEXING_TIER1_MODEL,
  MO_INDEXING_TIER2_FALLBACK,
  MO_INDEXING_TIER2_MODEL,
  OpenRouterProvider,
  type MoIndexingProvider,
  type MoIndexingTickDeps,
} from '../../../core/concierge/index.js';
import { BACKEND_CONFIGS, readEnvFirst } from './backend-configs.js';
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
} from './model-keys.js';
import { readBackend } from './provider-routing.js';
import type {
  ConciergeDepsHost,
  GatherModels,
  MergeResolverModels,
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
 * Backend gate (per design discussion 2026-04-28): the tick is
 * INTERNAL Morion architecture and we don't expose Tier 1 model
 * choice to users yet. For now it ONLY runs when:
 *   - `concierge.backend === 'openrouter'`
 *   - the OpenRouter key is configured (stored or env)
 *
 * Other backends + missing key → `resolveProvider()` returns null →
 * tick logs `gated_off` and bails. The V8 Worker proxy / Mo Managed
 * plan will replace this gate with its own routing.
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
  if (backend !== MO_INDEXING_REQUIRED_BACKEND) return null;
  const cfg = BACKEND_CONFIGS[backend];
  const storedKey = host.settings.get<string>(cfg.keySetting, '');
  const envKey = readEnvFirst(cfg.envKeys);
  const key = storedKey || envKey;
  if (!key) return null;
  try {
    // Tier 1 / Tier 2 indexing-pipeline overrides — empty stored
    // value falls back to the hardcoded constant. Same shape as
    // topic-hygiene below.
    const storedTier1 = host.settings
      .get<string>(tier1ModelKey(backend), '')
      .trim();
    const storedTier1Fallback = host.settings
      .get<string>(tier1FallbackKey(backend), '')
      .trim();
    const storedTier2 = host.settings
      .get<string>(tier2ModelKey(backend), '')
      .trim();
    const storedTier2Fallback = host.settings
      .get<string>(tier2FallbackKey(backend), '')
      .trim();
    const tier1Model = storedTier1 || MO_INDEXING_TIER1_MODEL;
    const tier1FallbackModel = storedTier1Fallback || MO_INDEXING_TIER1_FALLBACK;
    const tier2Model = storedTier2 || MO_INDEXING_TIER2_MODEL;
    const tier2FallbackModel = storedTier2Fallback || MO_INDEXING_TIER2_FALLBACK;
    // Topic-hygiene proposer model: separate per-backend setting.
    // Empty / unset → falls back to tier2Model (resolved above) which
    // is Qwen 235B by default but honors the user's tier2 override
    // when set.
    const storedHygiene = host.settings
      .get<string>(topicHygieneModelKey(backend), '')
      .trim();
    const storedHygieneFallback = host.settings
      .get<string>(topicHygieneFallbackKey(backend), '')
      .trim();
    const topicHygieneModel = storedHygiene || tier2Model;
    const topicHygieneFallbackModel = storedHygieneFallback
      ? storedHygieneFallback
      : storedHygiene
      ? tier2Model
      : tier2FallbackModel;
    return {
      provider: new OpenRouterProvider(key),
      tier1Model,
      tier1FallbackModel,
      tier2Model,
      tier2FallbackModel,
      topicHygieneModel,
      topicHygieneFallbackModel,
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
 *  Same OpenRouter-only gate as `resolveGatherModels`; test paths
 *  inject `providerOverride` and bypass the gate.
 *
 *  Empty primary → falls back to `MO_INDEXING_TIER2_MODEL` (Qwen 235B —
 *  cheap, often "good enough" for trivial conflicts). Empty fallback →
 *  single-attempt mode (no retry on primary failure). */
export function resolveMergeResolverModels(
  host: ConciergeDepsHost,
): MergeResolverModels | null {
  const backend = readBackend(host);
  if (backend !== MO_INDEXING_REQUIRED_BACKEND) {
    if (host.concierge.providerOverride) {
      return {
        primaryModel: MO_INDEXING_TIER2_MODEL,
        fallbackModel: '',
      };
    }
    return null;
  }
  const primary = host.settings
    .get<string>(mergeResolverModelKey(backend), '')
    .trim();
  const fallback = host.settings
    .get<string>(mergeResolverFallbackKey(backend), '')
    .trim();
  return {
    primaryModel: primary || MO_INDEXING_TIER2_MODEL,
    fallbackModel: fallback,
  };
}

/**
 * Resolve the gather pipeline's model picks from settings. Each falls
 * back to the existing indexing tier1/tier2 picks when unset, so the
 * engine works on any folder that's already Mo-indexed without extra
 * configuration.
 *
 * When the backend isn't OpenRouter AND there's no `providerOverride`,
 * returns null — production paths require the OpenRouter model lineup
 * (`qwen3.5-flash` / `deepseek-v4-*`) the engine was built around.
 * Test paths inject `providerOverride` and bypass the backend gate;
 * the model strings are echoed verbatim to the stub so they can be
 * any placeholder.
 */
export function resolveGatherModels(host: ConciergeDepsHost): GatherModels | null {
  const backend = readBackend(host);
  if (backend !== MO_INDEXING_REQUIRED_BACKEND) {
    if (host.concierge.providerOverride) {
      // Test path: stub provider doesn't care which model id we hand
      // it. Echo the indexing tier defaults so the call shape stays
      // identical to production.
      return {
        subagentModel: MO_INDEXING_TIER1_MODEL,
        synthesisModel: MO_INDEXING_TIER2_MODEL,
        synthesisThoroughModel: MO_INDEXING_TIER2_MODEL,
      };
    }
    return null;
  }

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
    subagentModel: subagent || MO_INDEXING_TIER1_MODEL,
    synthesisModel: synth || MO_INDEXING_TIER2_MODEL,
    synthesisThoroughModel: synthThorough || synth || MO_INDEXING_TIER2_MODEL,
  };
}

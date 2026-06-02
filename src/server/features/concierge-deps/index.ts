/**
 * Shared Concierge dependency factory — barrel re-export.
 *
 * Two callers need identical engine + brief deps:
 *   1. The HTTP route (`src/server/routes/concierge.ts`) — builds
 *      these per-request from the ToolContext so the user's manual
 *      "Run Mo now" / "Run digest now" / Ask Mo chat all use the
 *      currently-configured backend + key + model.
 *   2. The scheduler (`startHttpServer` → `ConciergeScheduler`) —
 *      builds these on every poll for the same reason: a settings
 *      flip between polls (user pasted a new key, switched backends,
 *      toggled Checking Corners master) must take effect without a
 *      server restart.
 *
 * Splits by concern:
 *
 *   - `concierge-deps/types.ts`              — host / bag / config shapes
 *   - `concierge-deps/backend-configs.ts`    — DEFAULT_BACKEND + BACKEND_CONFIGS
 *                                              + BACKEND_FACTORIES + readEnvFirst
 *   - `concierge-deps/provider-routing.ts`   — readBackend / readConfiguredProvider /
 *                                              readProviderModel / readChatModelFallback /
 *                                              buildAgentApiKeyEnv
 *   - `concierge-deps/model-keys.ts`         — per-backend setting-key getters
 *                                              (tier1/tier2/gather/topic-hygiene/merge-resolver)
 *   - `concierge-deps/recommended-models.ts` — UI placeholder constants
 *   - `concierge-deps/indexing-deps.ts`      — buildMoIndexingDeps /
 *                                              resolveMoIndexingProvider /
 *                                              resolveGatherProvider /
 *                                              buildTopicHygienePoll /
 *                                              resolveMergeResolverModels /
 *                                              resolveGatherModels
 *
 * The `host` shape is the minimum every caller carries: a DB handle,
 * the four core repositories the engine needs, the SettingsRepository
 * for provider routing + Checking Corners master, and the concierge
 * bag from `Runtime` (or the same shape narrowed off `ToolContext`).
 * Keeping the interface narrow lets tests pass a hand-built fake
 * without standing up a full Runtime.
 *
 * Originally a 785-LOC monolith; split into six modules under ticket
 * 01KRQS9TFTESS5QPHTX66Z3CZ2. Pure code-motion — every caller imports
 * from `concierge-deps.js` and gets the same surface.
 */

export type {
  ConciergeBackend,
  BackendConfig,
  ConciergeBag,
  ConciergeDepsHost,
  ConfiguredProvider,
  MergeResolverModels,
  GatherModels,
} from './types.js';

export {
  DEFAULT_BACKEND,
  BACKEND_CONFIGS,
  BACKEND_FACTORIES,
  readEnvFirst,
} from './backend-configs.js';

export {
  buildAgentApiKeyEnv,
  readBackend,
  readConfiguredProvider,
  readProviderModel,
  readChatModelFallback,
} from './provider-routing.js';

export {
  topicHygieneModelKey,
  topicHygieneFallbackKey,
  tier1ModelKey,
  tier1FallbackKey,
  tier2ModelKey,
  tier2FallbackKey,
  gatherSubagentModelKey,
  gatherSynthesisModelKey,
  gatherSynthesisThoroughModelKey,
  mergeResolverModelKey,
  mergeResolverFallbackKey,
} from './model-keys.js';

export {
  GATHER_SUBAGENT_RECOMMENDED,
  GATHER_SYNTHESIS_DEFAULT_RECOMMENDED,
  GATHER_SYNTHESIS_THOROUGH_RECOMMENDED,
  MERGE_RESOLVER_PRIMARY_RECOMMENDED,
  MERGE_RESOLVER_FALLBACK_RECOMMENDED,
} from './recommended-models.js';

export {
  buildMoIndexingDeps,
  resolveMoIndexingProvider,
  resolveGatherProvider,
  resolveMergeResolverModels,
  resolveGatherModels,
} from './indexing-deps.js';

export { buildTopicHygienePoll } from './topic-hygiene-poll.js';

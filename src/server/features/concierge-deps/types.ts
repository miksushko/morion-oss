/**
 * Public type surface for concierge dependency wiring. Pure shapes —
 * no runtime constants, no factories. Sub-modules under
 * `concierge-deps/` import from this file to express the host/bag
 * contract without circular dependencies.
 */
import type Database from 'better-sqlite3';
import type { NotesRepository } from '../../../core/notes/repository.js';
import type { FoldersRepository } from '../../../core/folders/repository.js';
import type { NoteCommentsRepository } from '../../../core/notes/comments-repository.js';
import type { SettingsRepository } from '../../../core/settings/repository.js';
import type {
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  BudgetTracker,
  LLMProvider,
  MoMemoryRepository,
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  MoMetadataVecRepository,
  MoMetadataQueueRepository,
  MoClusterQueueRepository,
  MoPatrolFindingsRepository,
  MoTopicDecisionsRepository,
  MoContextCacheRepository,
} from '../../../core/concierge/index.js';
import type { EmbeddingProvider } from '../../../core/embeddings/provider.js';

export type ConciergeBackend =
  | 'groq'
  | 'openrouter'
  | 'ollama'
  | 'openai'
  | 'anthropic';

export interface BackendConfig {
  keySetting: string;
  envKeys: readonly string[];
  modelSetting: string;
  /** Per-backend chat-tier fallback setting key. `completeWithFallback`
   * retries once on this model when primary fails. Empty → no retry. */
  chatFallbackModelSetting: string;
  /** Per-backend Project Brief digest tier. Cheap-fast model — runs
   * hourly per folder, summarises activity. Empty → brief skipped. */
  briefModelSetting: string;
  briefFallbackModelSetting: string;
}

export interface ConciergeBag {
  folderSettings: ConciergeFolderSettingsRepository;
  sessions: ConciergeSessionsRepository;
  messages: ConciergeMessagesRepository;
  /** Workspace-level Mo memory store — read by every smart tool's
   * system prompt; written by `mo_remember` (with conflict / dedup
   * detection) and the user via the Settings UI. */
  moMemory: MoMemoryRepository;
  budget: BudgetTracker;
  /** Mo Indexing Redesign Phase 1 storage. Optional so MCP tools and
   *  test harnesses that build their own ConciergeBag (without
   *  indexing repos) still type-check; production wiring in
   *  `buildRuntime` always populates them. The indexing factory
   *  asserts presence at call time. */
  moMetadata?: NoteMoMetadataRepository;
  moClusters?: NoteMoClustersRepository;
  /** Phase 2 metadata vector store. Backed by `mo_metadata_vec` (vec0
   *  virtual table); silent no-op when sqlite-vec is unavailable. */
  moMetadataVec?: MoMetadataVecRepository;
  moMetadataQueue?: MoMetadataQueueRepository;
  moClusterQueue?: MoClusterQueueRepository;
  /** Phase 5d patrol-finding lifecycle storage. */
  moPatrolFindings?: MoPatrolFindingsRepository;
  /** Topic-hygiene decision memory (mo_topic_decisions). Optional so
   *  test harnesses that don't need it can omit; production wiring
   *  always populates it. */
  moTopicDecisions?: MoTopicDecisionsRepository;
  /** Phase 5 deep-context-gather cache (`mo_context_cache`). Same
   *  optional-in-tests rule. */
  moContextCache?: MoContextCacheRepository;
  /** Test-only injection point — when set, both the chat path and the
   * scheduler use this provider instead of resolving Groq/OpenRouter
   * from settings. Production leaves it undefined. */
  providerOverride?: LLMProvider;
}

export interface ConciergeDepsHost {
  db: Database.Database;
  notes: NotesRepository;
  folders: FoldersRepository;
  comments: NoteCommentsRepository;
  settings: SettingsRepository;
  concierge: ConciergeBag;
  /** Phase 2: workspace-level embedder used by Tier 1 hook + indexing
   *  tick backfill sweep to populate `mo_metadata_vec`. Optional —
   *  when absent or returning null on `embed()`, the vec writes are
   *  silently skipped (downstream context-gather degrades to keyword
   *  search). Production wiring (`buildRuntime`) supplies it. */
  embeddings?: EmbeddingProvider;
}

export interface ConfiguredProvider {
  backend: ConciergeBackend;
  /** Effective key — stored value preferred, env fallback otherwise. Empty if neither. */
  key: string;
  /** Stored value alone (without env fallback). UI uses this to decide whether to mask. */
  storedKey: string;
  /** True iff `key` came from env, not stored settings. UI shows "configured via env". */
  envConfigured: boolean;
  /** Resolved model id. Per-backend setting → per-backend default. Legacy
   * `concierge.model` is intentionally ignored (Codex `01KQ1H63C2CAKAGVHM0ZB231TP`). */
  model: string;
}

export interface MergeResolverModels {
  /** Heavy frontier model for the actual resolve. */
  primaryModel: string;
  /** Lighter fallback fired when primary returns malformed output
   *  (e.g. leftover conflict markers) OR throws. Empty string = no
   *  fallback, surface primary's failure directly. */
  fallbackModel: string;
}

export interface GatherModels {
  /** Wave 1+2 sub-Mo workers. */
  subagentModel: string;
  /** Synth model for `mode: 'full'` / `mode: 'resume'`. */
  synthesisModel: string;
  /** Synth model for `mode: 'thorough'`. Falls back to `synthesisModel`
   *  when not set. */
  synthesisThoroughModel: string;
}

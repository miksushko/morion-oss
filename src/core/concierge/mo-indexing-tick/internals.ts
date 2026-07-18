import type Database from 'better-sqlite3';
import type { NotesRepository } from '../../notes/repository.js';
import type { FoldersRepository } from '../../folders/repository.js';
import type { SettingsRepository } from '../../settings/repository.js';
import type { ConciergeFolderSettingsRepository } from '../folder-settings-repository.js';
import type { LLMProvider } from '../provider.js';
import type { BudgetTracker } from '../budget.js';
import type { NoteMoMetadataRepository } from '../mo-metadata-repository.js';
import type { NoteMoClustersRepository } from '../mo-clusters-repository.js';
import type {
  MoMetadataQueueRepository,
  MoClusterQueueRepository,
} from '../mo-queue-repository.js';
import type { Tier1WorkerSummary } from '../mo-tier1-worker.js';
import type { Tier2WorkerSummary } from '../mo-tier2-worker.js';
import type { Tier25RunResult } from '../mo-tier25.js';
import type { MoMetadataVecRepository } from '../mo-metadata-vec.js';
import type { EmbeddingProvider } from '../../embeddings/provider.js';

/**
 * Shared constants + types for the mo-indexing-tick split (Morion
 * ticket 01KRQYSCEW185E1KVV8VZ5V36F). Re-exported through the barrel
 * `../mo-indexing-tick.ts`.
 */

export const MO_INDEXING_AUDIT_CHECKPOINT_KEY = 'mo.indexing.audit_checkpoint';
export const MO_INDEXING_TIER1_MODEL = 'mistralai/mistral-nemo';
export const MO_INDEXING_TIER1_FALLBACK = 'meta-llama/llama-3.1-8b-instruct';
export const MO_INDEXING_TIER2_MODEL = 'qwen/qwen3-235b-a22b-2507';
export const MO_INDEXING_TIER2_FALLBACK = 'mistralai/mistral-small-24b-instruct-2501';
/**
 * The backend whose Mo indexing / gather pipeline ships curated built-in
 * model defaults (`MO_INDEXING_TIER1_MODEL` etc.). Mo runs on ANY
 * configured backend, but only this one works with zero model config —
 * every other backend requires the user to set tier1 + tier2 explicitly
 * (vendor ids go stale + OpenRouter's namespaced ids 404 on direct APIs,
 * per the "no hardcoded model defaults" rule).
 */
export const MO_INDEXING_DEFAULTS_BACKEND = 'openrouter';
/**
 * Topic-hygiene proposer is a separate model pick — its job is
 * one-shot semantic dedup of a list of cluster ids, which benefits
 * from a model that's stronger than Tier 1 / Tier 2 on lexical
 * similarity reasoning. Recommended in the UI placeholder; not a
 * hardcoded default (per CLAUDE.md "No hardcoded model defaults" —
 * empty stored model resolves to `tier2Model` as a sane fallback).
 */
export const MO_INDEXING_TOPIC_HYGIENE_RECOMMENDED = 'deepseek/deepseek-v4-pro';

export const ENQUEUE_BATCH_LIMIT = 200;
export const BOOTSTRAP_BATCH = 100;
export const VEC_BACKFILL_BATCH = 50;
export const STALE_CLAIM_MS = 5 * 60 * 1000;
export const STALE_CATALOG_MS = 30 * 60 * 1000;

export interface MoIndexingProvider {
  provider: LLMProvider;
  tier1Model: string;
  tier1FallbackModel: string | null;
  tier2Model: string;
  tier2FallbackModel: string | null;
  /** Topic-hygiene proposer model. Falls back to `tier2Model` when
   *  the user hasn't set a dedicated model in workspace settings. */
  topicHygieneModel: string;
  topicHygieneFallbackModel: string | null;
}

export interface MoIndexingTickDeps {
  db: Database.Database;
  notes: NotesRepository;
  folders: FoldersRepository;
  workspaceSettings: SettingsRepository;
  folderSettings: ConciergeFolderSettingsRepository;
  metaRepo: NoteMoMetadataRepository;
  clustersRepo: NoteMoClustersRepository;
  metadataQueue: MoMetadataQueueRepository;
  clusterQueue: MoClusterQueueRepository;
  budget: BudgetTracker;
  /**
   * Phase 2 embedding pipeline. Both must be supplied together to
   * activate Mo's metadata vector store (`mo_metadata_vec`). Tier 1
   * writes through them post-upsert; the tick runs an additional
   * backfill sweep for any note whose metadata exists but whose
   * embedding row is missing. Either undefined → no-op (downstream
   * context-gather degrades to keyword search over summary).
   */
  vec?: MoMetadataVecRepository;
  embeddings?: EmbeddingProvider;
  /** Resolved fresh per-tick so user toggling backend / key takes
   *  effect immediately. Returns null when the gate isn't passed
   *  (wrong backend, missing key, master Mo disabled, etc.). */
  resolveProvider: () => MoIndexingProvider | null;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => number;
}

export type MoIndexingTickStatus = 'ok' | 'gated_off' | 'no_work';

export interface MoIndexingTickSummary {
  status: MoIndexingTickStatus;
  enqueued: number;
  newCheckpoint: number;
  /** Tier 1 (per-note) worker summary. Null when gated off. */
  worker: Tier1WorkerSummary | null;
  /** Tier 2 (cluster regen) worker summary. Null when gated off. */
  tier2: Tier2WorkerSummary | null;
  /** Tier 2.5 (catalog regen) results — one per folder that had a
   *  Tier 2 success in this tick. Empty array when no folders had
   *  cluster activity. Null when gated off. */
  tier25: Tier25RunResult[] | null;
}

export interface AuditRow {
  id: number;
  note_id: string;
  folder_id: string;
}

import type { NotesRepository } from '../notes/repository.js';
import type { LLMProvider } from './provider.js';
import type { BudgetTracker } from './budget.js';
import type { NoteMoMetadataRepository } from './mo-metadata-repository.js';
import type { NoteMoClustersRepository } from './mo-clusters-repository.js';
import type { MoMetadataVecRepository } from './mo-metadata-vec.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type {
  MoMetadataQueueRepository,
  MoMetadataQueueRow,
  MoClusterQueueRepository,
} from './mo-queue-repository.js';
import type Database from 'better-sqlite3';
import { runTier1ForNote, hashBody } from './mo-tier1.js';

/**
 * Mo Indexing Redesign — Phase 2b Tier 1 worker pool.
 *
 * Bounded-concurrency drainer for `mo_metadata_queue`. Claims a batch
 * of `tier='tier1'` rows, fans out `runTier1ForNote` in parallel
 * (`concurrency` cap), then either `complete()` or `release()` per
 * result. Loops until the queue is empty (within `maxBatches`) or
 * hits `maxItems`.
 *
 * Stateless function. Designed for both manual drivers (Phase 5
 * `mo_patrol` MCP tool) and the Phase 2c event subscriber.
 *
 * On a successful Tier 1 computation we additionally enqueue every
 * cluster id into `mo_cluster_queue` so the Phase 3 cluster regen
 * worker has a dirty signal. Cluster ids dedup across the batch —
 * one regen per cluster per drain call, not per note.
 *
 * Retry / abandon: each work-item carries `attempts`; release()
 * increments it. After `maxAttempts` (default 3) the item is
 * `complete()`d (removed) and reported via `result.abandonedItems[]`.
 *
 * Idempotency on body-hash race: before Tier 1 fires, we check
 * current `notes.body` hash against the work-item's `body_hash`. If
 * they don't match (another writer raced in between enqueue and
 * claim), we `complete()` the stale work-item — a fresh dirty-mark
 * with the new body_hash is already in the queue (or the next
 * `note_changed` event will re-enqueue).
 *
 * Per-drain reprocessing guard: release() makes a row available
 * again immediately. Without an in-memory `processedKeys` set, the
 * next claim() would pick it up in the same drain and a single drain
 * would burn through `maxAttempts`. The intended semantic is that
 * `release()` pushes the row to the NEXT drain call, with backoff
 * implied by however the caller paces drains.
 */

export interface Tier1WorkerDeps {
  db: Database.Database;
  notes: NotesRepository;
  metaRepo: NoteMoMetadataRepository;
  clustersRepo: NoteMoClustersRepository;
  metadataQueue: MoMetadataQueueRepository;
  clusterQueue: MoClusterQueueRepository;
  provider: LLMProvider;
  budget?: BudgetTracker;
  model: string;
  fallbackModel?: string | null;
  /** Phase 2 embedding pipeline. Both must be supplied together for
   *  Tier 1 to write the per-note metadata vector. Either undefined →
   *  vec write skipped (caught by indexing-tick backfill on next tick
   *  when both become available). */
  vec?: MoMetadataVecRepository;
  embeddings?: EmbeddingProvider;
}

export interface Tier1WorkerOptions {
  concurrency?: number;
  maxItems?: number;
  maxBatches?: number;
  maxAttempts?: number;
  /**
   * Per-folder cluster id resolver. Tier 1 needs the EXISTING cluster
   * ids for the note's folder so the prompt can ask the model to
   * prefer-known-over-propose-new. Callback shape (not a flat array)
   * because the queue interleaves notes from multiple folders inside
   * one claim — a single shared list would either under-supply some
   * folders or leak ids across folder boundaries (Case 26).
   * Caller is encouraged to memoise per drain (one folder repeats
   * across many rows).
   */
  knownClustersFor?: (folderId: string) => string[];
  /**
   * Per-folder generic-terms blocklist resolver. Same callback shape
   * as `knownClustersFor` and for the same reason — folder identity
   * varies across rows in one claim. Returns the user-set free-text
   * blocklist for the folder; empty string means "no per-folder
   * exclusions" and the prompt skips that block entirely.
   */
  topicExclusionsFor?: (folderId: string) => string;
  now?: number;
}

export interface Tier1WorkerSummary {
  claimed: number;
  computed: number;
  fresh: number;
  errors: number;
  abandoned: number;
  abandonedItems: Array<{
    folderId: string;
    noteId: string;
    attempts: number;
    reason: string;
  }>;
  dirtyClusters: string[];
}

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_BATCHES = 50;
const DEFAULT_MAX_ATTEMPTS = 3;

function workKey(row: MoMetadataQueueRow): string {
  return [row.folderId, row.noteId, row.tier].join('|');
}

export async function drainTier1Queue(
  deps: Tier1WorkerDeps,
  options: Tier1WorkerOptions = {},
): Promise<Tier1WorkerSummary> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const now = options.now;

  const summary: Tier1WorkerSummary = {
    claimed: 0,
    computed: 0,
    fresh: 0,
    errors: 0,
    abandoned: 0,
    abandonedItems: [],
    dirtyClusters: [],
  };
  const seenDirtyClusters = new Set<string>();
  const processedKeys = new Set<string>();

  const compensateAttemptBump = (row: MoMetadataQueueRow) => {
    deps.db
      .prepare(
        `UPDATE mo_metadata_queue
            SET attempts = MAX(0, attempts - 1)
          WHERE folder_id = ? AND note_id = ? AND tier = ?`,
      )
      .run(row.folderId, row.noteId, row.tier);
  };

  for (let batch = 0; batch < maxBatches; batch++) {
    const remaining = maxItems - summary.claimed;
    if (remaining <= 0) break;

    const claimSize = Math.min(concurrency, remaining);
    const claimed = deps.metadataQueue.claim('tier1', claimSize, now);
    if (claimed.length === 0) break;

    const fresh = claimed.filter((row) => !processedKeys.has(workKey(row)));

    // Re-release rows we already touched in THIS drain. release() bumps
    // `attempts` cosmetically — undo so a within-drain claim/re-release
    // doesn't masquerade as a real failure on the row's next pass.
    // Post-MVP: a `not_before` column gives proper per-row backoff and
    // removes the compensation hack.
    for (const row of claimed) {
      if (processedKeys.has(workKey(row))) {
        deps.metadataQueue.release(row.folderId, row.noteId, row.tier);
        compensateAttemptBump(row);
      }
    }
    if (fresh.length === 0) break;

    summary.claimed += fresh.length;
    for (const row of fresh) processedKeys.add(workKey(row));

    await Promise.all(
      fresh.map((row) =>
        processOne(deps, row, summary, seenDirtyClusters, maxAttempts, options),
      ),
    );
  }

  summary.dirtyClusters = Array.from(seenDirtyClusters);
  return summary;
}

async function processOne(
  deps: Tier1WorkerDeps,
  row: MoMetadataQueueRow,
  summary: Tier1WorkerSummary,
  seenDirtyClusters: Set<string>,
  maxAttempts: number,
  options: Tier1WorkerOptions,
): Promise<void> {
  const note = deps.notes.getById(row.noteId);
  if (!note) {
    deps.metadataQueue.complete(row.folderId, row.noteId, row.tier);
    summary.errors++;
    summary.abandonedItems.push({
      folderId: row.folderId,
      noteId: row.noteId,
      attempts: row.attempts,
      reason: 'note_not_found',
    });
    summary.abandoned++;
    return;
  }

  const currentHash = hashBody(note.body);
  if (currentHash !== row.bodyHash) {
    deps.metadataQueue.complete(row.folderId, row.noteId, row.tier);
    summary.fresh++;
    return;
  }

  const knownClusters = options.knownClustersFor
    ? options.knownClustersFor(row.folderId)
    : [];
  const topicExclusions = options.topicExclusionsFor
    ? options.topicExclusionsFor(row.folderId)
    : '';

  let result;
  try {
    result = await runTier1ForNote(
      {
        db: deps.db,
        notes: deps.notes,
        metaRepo: deps.metaRepo,
        clustersRepo: deps.clustersRepo,
        provider: deps.provider,
        budget: deps.budget,
        model: deps.model,
        fallbackModel: deps.fallbackModel,
        vec: deps.vec,
        embeddings: deps.embeddings,
      },
      row.noteId,
      {
        knownClusters,
        topicExclusions,
        now: options.now,
      },
    );
  } catch (err) {
    handleAttemptFailure(deps, row, summary, maxAttempts, (err as Error).message);
    return;
  }

  if (result.status === 'fresh') {
    deps.metadataQueue.complete(row.folderId, row.noteId, row.tier);
    summary.fresh++;
    return;
  }

  if (result.status === 'computed') {
    deps.metadataQueue.complete(row.folderId, row.noteId, row.tier);
    summary.computed++;
    for (const c of result.output.clusterCandidates) {
      // Always enqueue — `mo_cluster_queue.enqueue` is itself a
      // coalescing INSERT on `(folder_id, cluster_id)`, idempotent.
      // The summary list dedupes by cluster id alone (cross-folder
      // collisions: same cluster id in two folders shows up once in
      // `summary.dirtyClusters`); the queue keeps both as distinct
      // rows because each folder needs its own regen.
      deps.clusterQueue.enqueue(row.folderId, c.clusterId, options.now);
      if (!seenDirtyClusters.has(c.clusterId)) {
        seenDirtyClusters.add(c.clusterId);
      }
    }
    return;
  }

  if (result.reason === 'note_not_found' || result.reason === 'budget_exceeded') {
    deps.metadataQueue.complete(row.folderId, row.noteId, row.tier);
    summary.errors++;
    summary.abandoned++;
    summary.abandonedItems.push({
      folderId: row.folderId,
      noteId: row.noteId,
      attempts: row.attempts,
      reason: result.reason,
    });
    return;
  }

  handleAttemptFailure(deps, row, summary, maxAttempts, result.message);
}

function handleAttemptFailure(
  deps: Tier1WorkerDeps,
  row: MoMetadataQueueRow,
  summary: Tier1WorkerSummary,
  maxAttempts: number,
  reason: string,
): void {
  summary.errors++;
  if (row.attempts + 1 >= maxAttempts) {
    deps.metadataQueue.complete(row.folderId, row.noteId, row.tier);
    summary.abandoned++;
    summary.abandonedItems.push({
      folderId: row.folderId,
      noteId: row.noteId,
      attempts: row.attempts + 1,
      reason,
    });
    return;
  }
  deps.metadataQueue.release(row.folderId, row.noteId, row.tier);
}

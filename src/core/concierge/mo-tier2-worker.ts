import type Database from 'better-sqlite3';
import type { NotesRepository } from '../notes/repository.js';
import type { LLMProvider } from './provider.js';
import type { BudgetTracker } from './budget.js';
import type { NoteMoMetadataRepository } from './mo-metadata-repository.js';
import type { NoteMoClustersRepository } from './mo-clusters-repository.js';
import type {
  MoClusterQueueRepository,
  MoClusterQueueRow,
} from './mo-queue-repository.js';
import { runTier2ForCluster } from './mo-tier2.js';

/**
 * Mo Indexing Redesign — Phase 3b Tier 2 cluster aggregator drainer.
 *
 * Bounded-concurrency worker for `mo_cluster_queue` rows that Phase 2's
 * Tier 1 worker enqueues whenever a note's classification touches a
 * cluster id.
 *
 * Differences from `drainTier1Queue`:
 *   - claims rows whose `dirty_since <= now - debounceMs`. Tier 2 is
 *     heavier than Tier 1 (bigger context, mid-tier model) so we
 *     wait for a quiet window before regenerating — bursts of Tier 1
 *     completions in one cluster collapse into one regen.
 *   - much smaller default concurrency (2) — the LLM context is bigger
 *     and provider rate limits matter more.
 *   - calls `runTier2ForCluster` per claim; per-cluster atomicity
 *     (one regen at a time per cluster) is provided by the queue's
 *     `(folder_id, cluster_id)` PK + claim-by-picked_at semantics.
 *
 * Same per-drain processed-key guard as `drainTier1Queue` — release()
 * makes a row available again immediately, so without an in-memory
 * Set the loop would burn through `maxAttempts` in one pass.
 *
 * Empty / not_ready Tier 2 results are SUCCESSES from the queue's
 * perspective (the cluster genuinely has no work); complete() the row
 * so we don't poll the same empty cluster every drain. A future
 * Tier 1 completion will re-enqueue if the cluster picks up notes.
 */

export interface Tier2WorkerDeps {
  db: Database.Database;
  notes: NotesRepository;
  metaRepo: NoteMoMetadataRepository;
  clustersRepo: NoteMoClustersRepository;
  clusterQueue: MoClusterQueueRepository;
  provider: LLMProvider;
  budget?: BudgetTracker;
  model: string;
  fallbackModel?: string | null;
}

export interface Tier2WorkerOptions {
  /** Wait this long since `dirty_since` before claiming a cluster.
   *  Default 60s — gives Tier 1 bursts a chance to finish so one
   *  regen covers all dirty notes in the cluster. */
  debounceMs?: number;
  /** Max parallel runTier2ForCluster calls. Tier 2 is heavier than
   *  Tier 1 (bigger context); default 2. */
  concurrency?: number;
  /** Cap on rows processed per drain call. Default 30. */
  maxItems?: number;
  /** Cap on claim batches per drain. Default 30. */
  maxBatches?: number;
  /** Abandon after this many failed attempts. Default 3. */
  maxAttempts?: number;
  /** Resolve per-cluster house rules from folder settings (Phase 6
   *  Tasks Topics tab). Threaded through to runTier2ForCluster. */
  houseRulesFor?: (folderId: string, clusterId: string) => string | undefined;
  /** Override Date.now (tests). */
  now?: () => number;
}

export interface Tier2WorkerSummary {
  claimed: number;
  computed: number;
  empty: number;
  errors: number;
  abandoned: number;
  abandonedItems: Array<{
    folderId: string;
    clusterId: string;
    attempts: number;
    reason: string;
  }>;
  /** Distinct folder ids whose Tier 2 work resulted in `computed`.
   *  Phase 4b uses this to drive Tier 2.5 (mo:catalog) regen — one
   *  Tier 2.5 call per folder that actually had cluster activity.
   *  Empty folders + folders that only had failures don't appear. */
  computedFolders: string[];
}

const DEFAULT_DEBOUNCE_MS = 60_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_ITEMS = 30;
const DEFAULT_MAX_BATCHES = 30;
const DEFAULT_MAX_ATTEMPTS = 3;

function workKey(row: MoClusterQueueRow): string {
  return [row.folderId, row.clusterId].join('|');
}

export async function drainTier2Queue(
  deps: Tier2WorkerDeps,
  options: Tier2WorkerOptions = {},
): Promise<Tier2WorkerSummary> {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const nowFn = options.now ?? (() => Date.now());

  const summary: Tier2WorkerSummary = {
    claimed: 0,
    computed: 0,
    empty: 0,
    errors: 0,
    abandoned: 0,
    abandonedItems: [],
    computedFolders: [],
  };
  const processedKeys = new Set<string>();
  const computedFolderSet = new Set<string>();

  const compensateAttemptBump = (row: MoClusterQueueRow) => {
    deps.db
      .prepare(
        `UPDATE mo_cluster_queue
            SET attempts = MAX(0, attempts - 1)
          WHERE folder_id = ? AND cluster_id = ?`,
      )
      .run(row.folderId, row.clusterId);
  };

  for (let batch = 0; batch < maxBatches; batch++) {
    const remaining = maxItems - summary.claimed;
    if (remaining <= 0) break;

    const now = nowFn();
    const olderThan = now - debounceMs;
    const claimSize = Math.min(concurrency, remaining);
    const claimed = deps.clusterQueue.claim(olderThan, claimSize, now);
    if (claimed.length === 0) break;

    const fresh = claimed.filter((row) => !processedKeys.has(workKey(row)));
    for (const row of claimed) {
      if (processedKeys.has(workKey(row))) {
        deps.clusterQueue.release(row.folderId, row.clusterId);
        compensateAttemptBump(row);
      }
    }
    if (fresh.length === 0) break;

    summary.claimed += fresh.length;
    for (const row of fresh) processedKeys.add(workKey(row));

    await Promise.all(
      fresh.map((row) =>
        processOne(deps, row, summary, computedFolderSet, maxAttempts, options),
      ),
    );
  }

  summary.computedFolders = Array.from(computedFolderSet);
  return summary;
}

async function processOne(
  deps: Tier2WorkerDeps,
  row: MoClusterQueueRow,
  summary: Tier2WorkerSummary,
  computedFolderSet: Set<string>,
  maxAttempts: number,
  options: Tier2WorkerOptions,
): Promise<void> {
  const houseRules = options.houseRulesFor?.(row.folderId, row.clusterId);
  let result;
  try {
    result = await runTier2ForCluster(
      {
        db: deps.db,
        notes: deps.notes,
        metaRepo: deps.metaRepo,
        clustersRepo: deps.clustersRepo,
        provider: deps.provider,
        budget: deps.budget,
        model: deps.model,
        fallbackModel: deps.fallbackModel,
      },
      row.folderId,
      row.clusterId,
      {
        houseRules,
        now: options.now?.(),
      },
    );
  } catch (err) {
    handleAttemptFailure(deps, row, summary, maxAttempts, (err as Error).message);
    return;
  }

  if (result.status === 'computed') {
    deps.clusterQueue.complete(row.folderId, row.clusterId);
    summary.computed++;
    computedFolderSet.add(row.folderId);
    return;
  }

  if (result.status === 'empty') {
    // The cluster genuinely has no notes (or none with Tier 1 metadata).
    // Treat as success — complete the row so we don't re-poll an empty
    // cluster every drain. A future Tier 1 completion that touches this
    // cluster id will re-enqueue.
    deps.clusterQueue.complete(row.folderId, row.clusterId);
    summary.empty++;
    return;
  }

  // result.status === 'error'
  if (result.reason === 'budget_exceeded') {
    // Terminal — abandon (no point retrying this minute; the budget
    // resets monthly).
    deps.clusterQueue.complete(row.folderId, row.clusterId);
    summary.errors++;
    summary.abandoned++;
    summary.abandonedItems.push({
      folderId: row.folderId,
      clusterId: row.clusterId,
      attempts: row.attempts,
      reason: result.reason,
    });
    return;
  }

  // Transient — invalid_response, provider_failed. Release for retry.
  handleAttemptFailure(deps, row, summary, maxAttempts, result.message);
}

function handleAttemptFailure(
  deps: Tier2WorkerDeps,
  row: MoClusterQueueRow,
  summary: Tier2WorkerSummary,
  maxAttempts: number,
  reason: string,
): void {
  summary.errors++;
  if (row.attempts + 1 >= maxAttempts) {
    deps.clusterQueue.complete(row.folderId, row.clusterId);
    summary.abandoned++;
    summary.abandonedItems.push({
      folderId: row.folderId,
      clusterId: row.clusterId,
      attempts: row.attempts + 1,
      reason,
    });
    return;
  }
  deps.clusterQueue.release(row.folderId, row.clusterId);
}

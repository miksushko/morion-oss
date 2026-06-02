import { drainTier1Queue } from './mo-tier1-worker.js';
import { drainTier2Queue } from './mo-tier2-worker.js';
import { runTier25ForFolder, type Tier25RunResult } from './mo-tier25.js';
import { pollAuditLogAndEnqueue } from './mo-indexing-tick/audit-poll.js';
import { runBootstrapSweep } from './mo-indexing-tick/bootstrap-sweep.js';
import { runVecBackfill } from './mo-indexing-tick/vec-backfill.js';
import { collectTier25Folders } from './mo-indexing-tick/tier25-targets.js';
import {
  MO_INDEXING_AUDIT_CHECKPOINT_KEY,
  STALE_CLAIM_MS,
  VEC_BACKFILL_BATCH,
  type MoIndexingTickDeps,
  type MoIndexingTickStatus,
  type MoIndexingTickSummary,
} from './mo-indexing-tick/internals.js';

/**
 * Mo Indexing Redesign — Phase 2c indexing tick.
 *
 * Periodic driver that bridges Phase 1's queue + Phase 2's worker
 * pool to actual production note edits.
 *
 * Cadence: hooked into `ConciergeScheduler.poll()` with a 60s
 * minimum-interval guard so the existing 30s scheduler poll fires
 * us at most every other tick.
 *
 * Source-of-truth for "what changed": `audit_log`. Every note
 * mutation already writes a row there (`actor`, `action`, `note_id`,
 * `ts`). The tick polls rows newer than its checkpoint, joins to
 * `notes` + `concierge_folder_settings`, and enqueues into
 * `mo_metadata_queue`.
 *
 * Why audit_log rather than a NotesRepository hook:
 *   - already the canonical "what mutated" log; reusing it avoids
 *     duplicating the listener at every write site.
 *   - filters cleanly by actor (skip own writes — feedback-loop
 *     guard, the same shape that bit `01KQ2BVN19Z46HKJ7V8GSAYTZJ`).
 *   - works for HTTP, MCP, and internal writes uniformly.
 *
 * Backend gate (per design discussion 2026-04-28): the tick is
 * INTERNAL Morion architecture and we don't expose Tier 1 model
 * choice in the UI. For now it runs ONLY when the user has
 * OpenRouter selected as their Mo backend with a configured key.
 * Other backends + missing key → no-op until the V8 Worker proxy /
 * Mo Managed plan ships its own routing.
 *
 * Module layout — per the 2026-05-16 split (Morion ticket
 * 01KRQYSCEW185E1KVV8VZ5V36F):
 *   - `./mo-indexing-tick/internals.ts`     constants + types.
 *   - `./mo-indexing-tick/audit-poll.ts`    step 1: incremental.
 *   - `./mo-indexing-tick/bootstrap-sweep.ts` step 1.5: ghost-state.
 *   - `./mo-indexing-tick/vec-backfill.ts`  step 1b: embeddings.
 *   - `./mo-indexing-tick/tier25-targets.ts` step 4: catalog targets.
 *   - this file                             — `runMoIndexingTick`
 *                                              orchestrator + public
 *                                              re-exports.
 */

// Re-export public surface so existing importers
// (`from '.../concierge/mo-indexing-tick.js'`) keep working unchanged.
export {
  MO_INDEXING_AUDIT_CHECKPOINT_KEY,
  MO_INDEXING_TIER1_MODEL,
  MO_INDEXING_TIER1_FALLBACK,
  MO_INDEXING_TIER2_MODEL,
  MO_INDEXING_TIER2_FALLBACK,
  MO_INDEXING_REQUIRED_BACKEND,
  MO_INDEXING_TOPIC_HYGIENE_RECOMMENDED,
  type MoIndexingProvider,
  type MoIndexingTickDeps,
  type MoIndexingTickStatus,
  type MoIndexingTickSummary,
} from './mo-indexing-tick/internals.js';

/**
 * Run one indexing tick. Returns a summary the scheduler logs.
 * Idempotent — re-running with the same audit_log state is a no-op
 * (checkpoint advances only when there's new work).
 */
export async function runMoIndexingTick(
  deps: MoIndexingTickDeps,
): Promise<MoIndexingTickSummary> {
  const log = deps.log;
  const now = deps.now?.() ?? Date.now();

  const provider = deps.resolveProvider();
  if (!provider) {
    log?.info('mo indexing tick gated off (no provider)');
    return {
      status: 'gated_off',
      enqueued: 0,
      newCheckpoint: deps.workspaceSettings.get<number>(
        MO_INDEXING_AUDIT_CHECKPOINT_KEY,
        0,
      ),
      worker: null,
      tier2: null,
      tier25: null,
    };
  }

  // 0. Self-recovery: release every claim older than 5 minutes
  //    before we touch the queue. A crashed worker (process restart,
  //    SIGKILL, app close mid-LLM-call) leaves `picked_at` set
  //    forever; without this pass the row becomes invisible to
  //    `claim()` and the user sees "stuck" topics that never
  //    finish. 5 min is comfortably longer than any reasonable
  //    Tier 1 / Tier 2 LLM call.
  const releasedMeta = deps.metadataQueue.releaseStuck(STALE_CLAIM_MS, now);
  const releasedCluster = deps.clusterQueue.releaseStuck(STALE_CLAIM_MS, now);
  if (releasedMeta > 0 || releasedCluster > 0) {
    log?.info('mo indexing tick released stuck claims', {
      metaQueue: releasedMeta,
      clusterQueue: releasedCluster,
    });
  }

  // 1. Poll audit_log for note mutations newer than the checkpoint.
  const audit = pollAuditLogAndEnqueue(deps, now);
  let enqueued = audit.enqueued;
  const maxId = audit.newCheckpoint;

  // 1.5. Bootstrap sweep — initial Tier 1 coverage for notes that
  //      have never been processed.
  const bootstrapEnqueued = runBootstrapSweep(deps, now);
  if (bootstrapEnqueued > 0) {
    log?.info('mo indexing bootstrap sweep enqueued backlog', {
      enqueued: bootstrapEnqueued,
      batchCap: 100,
    });
    enqueued += bootstrapEnqueued;
  }

  // 1b. Phase 2 embedding backfill — notes WITH Tier 1 metadata but
  //     WITHOUT a `mo_metadata_vec` row.
  const vecResult = await runVecBackfill(deps);
  if (vecResult && (vecResult.backfilled > 0 || vecResult.skipped > 0)) {
    log?.info('mo metadata vec backfill swept', {
      backfilled: vecResult.backfilled,
      skipped: vecResult.skipped,
      batchCap: VEC_BACKFILL_BATCH,
    });
  }

  // 2. Drain Tier 1 (per-note) work. Concurrency stays at the worker
  //    default; a future MoIndexingTickOptions extension can plumb a
  //    per-backend cap.
  //
  //    `knownClustersFor` is the prevention-side fix for topic drift:
  //    without it Tier 1's prompt always took the empty-folder branch
  //    ("propose new cluster ids based on the note's topic"), so every
  //    classification generated fresh slugs and singletons piled up
  //    (376 clusters / 142 notes on Morion Features as of 2026-05-02).
  //    The drain-scoped Map memoises per folder — a typical claim is
  //    a handful of folders repeated across many rows, so this saves
  //    the JOIN on every processOne call.
  const knownClustersCache = new Map<string, string[]>();
  const knownClustersFor = (folderId: string): string[] => {
    let cached = knownClustersCache.get(folderId);
    if (!cached) {
      cached = deps.clustersRepo.listClusterIdsForFolder(folderId);
      knownClustersCache.set(folderId, cached);
    }
    return cached;
  };

  // Same memo pattern for the per-folder generic-terms blocklist —
  // settings rarely change mid-drain, and the row repeats per folder.
  const topicExclusionsCache = new Map<string, string>();
  const topicExclusionsFor = (folderId: string): string => {
    const hit = topicExclusionsCache.get(folderId);
    if (hit !== undefined) return hit;
    const value = deps.folderSettings.getOrDefault(folderId).topicExclusions ?? '';
    topicExclusionsCache.set(folderId, value);
    return value;
  };

  const workerSummary = await drainTier1Queue(
    {
      db: deps.db,
      notes: deps.notes,
      metaRepo: deps.metaRepo,
      clustersRepo: deps.clustersRepo,
      metadataQueue: deps.metadataQueue,
      clusterQueue: deps.clusterQueue,
      provider: provider.provider,
      budget: deps.budget,
      model: provider.tier1Model,
      fallbackModel: provider.tier1FallbackModel,
      vec: deps.vec,
      embeddings: deps.embeddings,
    },
    { now, knownClustersFor, topicExclusionsFor },
  );

  // 3. Drain Tier 2 (cluster regen) work. The cluster queue's debounce
  //    threshold (60s default in drainTier2Queue) means a cluster that
  //    Tier 1 just marked dirty in step 2 will NOT be claimed in this
  //    same tick — it has to age for at least one debounce window. So
  //    on a fresh edit: tick N runs Tier 1 + enqueues cluster, tick N+1
  //    runs Tier 2 (assuming no further Tier 1 activity).
  const tier2Summary = await drainTier2Queue(
    {
      db: deps.db,
      notes: deps.notes,
      metaRepo: deps.metaRepo,
      clustersRepo: deps.clustersRepo,
      clusterQueue: deps.clusterQueue,
      provider: provider.provider,
      budget: deps.budget,
      model: provider.tier2Model,
      fallbackModel: provider.tier2FallbackModel,
    },
    { now: () => now },
  );

  // 4. Tier 2.5 (mo:catalog). See `collectTier25Folders` for the
  //    self-recovery v2 union of paths.
  const tier25Folders = collectTier25Folders(
    deps,
    tier2Summary.computedFolders,
    now,
  );
  const tier25Results: Tier25RunResult[] = [];
  for (const folderId of tier25Folders) {
    try {
      const result = await runTier25ForFolder(
        {
          db: deps.db,
          notes: deps.notes,
          folders: deps.folders,
          metaRepo: deps.metaRepo,
          clustersRepo: deps.clustersRepo,
          provider: provider.provider,
          budget: deps.budget,
          model: provider.tier2Model,
          fallbackModel: provider.tier2FallbackModel,
        },
        folderId,
        { now },
      );
      tier25Results.push(result);
    } catch (err) {
      tier25Results.push({
        status: 'error',
        reason: 'provider_failed',
        message: (err as Error).message ?? 'tier 2.5 threw',
      });
    }
  }

  const totalActivity =
    enqueued + workerSummary.claimed + tier2Summary.claimed;
  const status: MoIndexingTickStatus = totalActivity === 0 ? 'no_work' : 'ok';

  if (log) {
    const tier25Computed = tier25Results.filter((r) => r.status === 'computed').length;
    log.info('mo indexing tick complete', {
      status,
      enqueued,
      checkpoint: maxId,
      tier1: {
        computed: workerSummary.computed,
        fresh: workerSummary.fresh,
        errors: workerSummary.errors,
        abandoned: workerSummary.abandoned,
        dirtyClusters: workerSummary.dirtyClusters.length,
      },
      tier2: {
        computed: tier2Summary.computed,
        empty: tier2Summary.empty,
        errors: tier2Summary.errors,
        abandoned: tier2Summary.abandoned,
        computedFolders: tier2Summary.computedFolders.length,
      },
      tier25: {
        attempted: tier25Results.length,
        computed: tier25Computed,
      },
    });
  }

  return {
    status,
    enqueued,
    newCheckpoint: maxId,
    worker: workerSummary,
    tier2: tier2Summary,
    tier25: tier25Results,
  };
}

import { hashBody } from '../mo-tier1.js';
import { BOOTSTRAP_BATCH, type MoIndexingTickDeps } from './internals.js';

/**
 * Step 1.5 — bootstrap sweep. Initial Tier 1 coverage for notes that
 * have never been processed. The audit_log → enqueue path in
 * `pollAuditLogAndEnqueue` only sees notes that received a write
 * event AFTER Phase 2c shipped. Folders that were Mo-enabled BEFORE
 * the pipeline came online (or notes that simply haven't been edited
 * since) accumulate a long tail of metadata-less rows that would
 * otherwise sit invisible to the index forever.
 *
 * Selects up to `BOOTSTRAP_BATCH` notes that:
 *   - belong to a Mo-enabled, non-archived folder,
 *   - have NO row in `note_mo_metadata` (never processed),
 *   - have NO row in `mo_metadata_queue` already (so we don't
 *     reset `attempts` on a row mid-retry),
 *   - aren't deleted / archived / mo:* system notes.
 *
 * Coalescing UPSERT in `enqueue` makes re-runs idempotent;
 * Tier 1 worker pool's bounded provider concurrency caps actual LLM
 * spend per tick. Fires every tick until coverage is reached, then
 * becomes a no-op (same shape as the catalog/cluster ghost-state
 * recovery loops).
 */
interface BootstrapRow {
  id: string;
  folder_id: string;
  body: string;
}

export function runBootstrapSweep(
  deps: MoIndexingTickDeps,
  now: number,
): number {
  const bootstrapRows = deps.db
    .prepare<[number], BootstrapRow>(
      `SELECT n.id, n.folder_id, n.body
         FROM notes n
         JOIN concierge_folder_settings cfs ON cfs.folder_id = n.folder_id
         LEFT JOIN folders f ON f.id = n.folder_id
         LEFT JOIN note_mo_metadata m ON m.note_id = n.id
         LEFT JOIN mo_metadata_queue q
                ON q.note_id = n.id
               AND q.folder_id = n.folder_id
               AND q.tier = 'tier1'
        WHERE m.note_id IS NULL
          AND q.note_id IS NULL
          AND n.deleted_at IS NULL
          AND n.archived_at IS NULL
          AND (f.archived_at IS NULL)
          AND cfs.enabled = 1
          AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
        ORDER BY n.created_at ASC
        LIMIT ?`,
    )
    .all(BOOTSTRAP_BATCH);
  let enqueued = 0;
  for (const row of bootstrapRows) {
    deps.metadataQueue.enqueue(
      row.folder_id,
      row.id,
      'tier1',
      hashBody(row.body),
      now,
    );
    enqueued++;
  }
  return enqueued;
}

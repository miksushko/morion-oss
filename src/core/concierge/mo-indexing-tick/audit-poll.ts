import { hashBody } from '../mo-tier1.js';
import { CONCIERGE_ACTOR } from '../types.js';
import {
  AuditRow,
  ENQUEUE_BATCH_LIMIT,
  MO_INDEXING_AUDIT_CHECKPOINT_KEY,
  type MoIndexingTickDeps,
} from './internals.js';

/**
 * Step 1 — audit-log polling. Read audit rows newer than the stored
 * checkpoint, filter to Mo-enabled non-archived non-deleted notes,
 * enqueue each as Tier 1 work, advance the checkpoint.
 *
 * Returns `{enqueued, newCheckpoint}` so the orchestrator can fold
 * the audit-driven enqueue count into the tick-wide total.
 *
 * Feedback-loop guard: filters out audit rows authored by
 * `morion-concierge` (Mo's own writes — patrol-log appends, Tier 2
 * cluster writes, etc.). Same shape that bit
 * `01KQ2BVN19Z46HKJ7V8GSAYTZJ`.
 */
export function pollAuditLogAndEnqueue(
  deps: MoIndexingTickDeps,
  now: number,
): { enqueued: number; newCheckpoint: number } {
  const checkpoint = deps.workspaceSettings.get<number>(
    MO_INDEXING_AUDIT_CHECKPOINT_KEY,
    0,
  );
  const auditRows = deps.db
    .prepare<[number, string, number], AuditRow>(
      `SELECT a.id, a.note_id, n.folder_id
         FROM audit_log a
         JOIN notes n ON n.id = a.note_id
         JOIN concierge_folder_settings cfs ON cfs.folder_id = n.folder_id
         LEFT JOIN folders f ON f.id = n.folder_id
        WHERE a.id > ?
          AND a.action IN ('create', 'update')
          AND a.actor != ?
          AND a.note_id IS NOT NULL
          AND n.deleted_at IS NULL
          AND n.archived_at IS NULL
          AND (f.archived_at IS NULL)
          AND cfs.enabled = 1
          AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
        ORDER BY a.id ASC
        LIMIT ?`,
    )
    .all(checkpoint, CONCIERGE_ACTOR, ENQUEUE_BATCH_LIMIT);

  let maxId = checkpoint;
  let enqueued = 0;
  for (const row of auditRows) {
    if (row.id > maxId) maxId = row.id;
    const note = deps.notes.getById(row.note_id);
    // Note may have been hard-deleted between the audit insert and
    // now — skip without enqueue (feedback-loop free; the audit row
    // is still bypassed via id ordering).
    if (!note || note.folderId !== row.folder_id) continue;
    deps.metadataQueue.enqueue(
      row.folder_id,
      note.id,
      'tier1',
      hashBody(note.body),
      now,
    );
    enqueued++;
  }
  if (auditRows.length > 0 && maxId > checkpoint) {
    deps.workspaceSettings.set(MO_INDEXING_AUDIT_CHECKPOINT_KEY, maxId);
  }
  return { enqueued, newCheckpoint: maxId };
}

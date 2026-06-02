import type { AutoCodeDispatcher } from '../auto-code-factory/index.js';
import {
  AUTO_CODE_AUDIT_CHECKPOINT_KEY,
  defaultLog,
  folderSweepKey,
  type AutoCodeTickDeps,
  type EnqueueTickSummary,
} from './internals.js';
import { maybePostRejectionComment } from './rejection-comments.js';

/**
 * Per-folder full scan — for each auto-code-enabled folder whose
 * sweep marker is NOT set, pick up every ticket currently in
 * `status='todo'` that has NO active workflow_run AND no active
 * legacy `mo_agent_queue` row, and enqueue them. Mark the folder's
 * sweep done IFF processing completed without any throws.
 *
 * Why per-folder (vs the previous workspace-wide marker):
 *
 *   1. The previous marker was a P1: enabling auto-code on a folder
 *      AFTER the first sweep silently lost every pre-existing `todo`
 *      ticket in that folder. Per-folder marker means a freshly-
 *      enabled folder gets scanned on the next scheduler poll.
 *   2. A transient throw on one folder doesn't poison the marker
 *      for OTHER folders that processed cleanly — each folder's
 *      success / failure is independent.
 *
 * Marker semantics:
 *
 *   - Set ONLY when the folder's pass had zero `enqueueTicket`
 *     throws. Pure rejections (gates failed deterministically) DO
 *     mark the folder done — those tickets won't change without a
 *     deliberate config flip, and the audit subscriber will
 *     re-trigger if the user does flip something.
 *   - Throws leave the marker unset → next poll retries.
 *
 * Pass `force: true` to bypass markers entirely (useful for tests
 * + a future "rescan now" admin button).
 *
 * Safe to call on every scheduler poll — the per-folder marker
 * makes repeat invocations cheap (one DB read per enabled folder).
 */
export async function runAutoCodeStartupSweep(
  deps: AutoCodeTickDeps,
  opts: { force?: boolean; now?: number } = {},
): Promise<EnqueueTickSummary> {
  const log = deps.log ?? defaultLog();

  const now = opts.now ?? Date.now();
  const summary: EnqueueTickSummary = {
    audited: 0,
    enqueued: 0,
    rejected: {},
    newCheckpoint: deps.workspaceSettings.get<number>(
      AUTO_CODE_AUDIT_CHECKPOINT_KEY,
      0,
    ),
  };

  // List enabled folders that haven't been swept yet. Cheap read —
  // typically <10 folders. Each folder's marker check is one
  // settings.get; we batch by skipping done folders entirely.
  const enabledFolders = deps.db
    .prepare<[], { folder_id: string }>(
      `SELECT cfs.folder_id
         FROM concierge_folder_settings cfs
         LEFT JOIN folders f ON f.id = cfs.folder_id
        WHERE cfs.auto_code_enabled = 1
          AND cfs.enabled = 1
          AND cfs.linked_repo_path IS NOT NULL
          AND f.archived_at IS NULL`,
    )
    .all();

  if (enabledFolders.length === 0) return summary;

  let dispatcher: AutoCodeDispatcher | null = null;
  for (const folder of enabledFolders) {
    const markerKey = folderSweepKey(folder.folder_id);
    if (!opts.force) {
      const lastSweepAt = deps.workspaceSettings.get<number>(markerKey, 0);
      if (lastSweepAt > 0) continue;
    }

    // Per-folder scan: tickets in `todo` for THIS folder with no
    // active workflow_run / legacy queue row.
    const rows = deps.db
      .prepare<[string], { id: string; folder_id: string }>(
        `SELECT n.id, n.folder_id
           FROM notes n
           LEFT JOIN workflow_runs wr
             ON wr.ticket_id = n.id
             AND wr.status IN ('pending','running','paused_ask_user')
           LEFT JOIN mo_agent_queue mq
             ON mq.task_id = n.id
             AND mq.state NOT IN ('done','failed','cancelled')
          WHERE n.folder_id = ?
            AND n.status = 'todo'
            AND n.deleted_at IS NULL
            AND n.archived_at IS NULL
            AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
            AND wr.id IS NULL
            AND mq.id IS NULL
          ORDER BY n.created_at ASC`,
      )
      .all(folder.folder_id);

    summary.audited += rows.length;

    if (rows.length === 0) {
      // Empty folder — mark done so we don't re-scan on every poll.
      deps.workspaceSettings.set(markerKey, now);
      continue;
    }

    let folderHadThrow = false;
    for (const row of rows) {
      if (!dispatcher) {
        try {
          dispatcher = await deps.buildDispatcher();
        } catch (err) {
          log.warn('buildDispatcher threw during startup sweep', {
            error: (err as Error).message,
          });
          // Whole sweep aborts; no folder marker set; retry next poll.
          return summary;
        }
      }
      try {
        const out = await dispatcher.enqueueTicket(row.id, row.folder_id);
        if (out.kind === 'enqueued') {
          summary.enqueued += 1;
        } else {
          summary.rejected[out.reason] = (summary.rejected[out.reason] ?? 0) + 1;
          // Same Fix B path as the incremental tick — startup sweep
          // also needs to surface rejections so the user finds out why
          // a pre-existing `todo` ticket didn't pick up.
          maybePostRejectionComment(deps, row.id, out, Date.now());
        }
      } catch (err) {
        folderHadThrow = true;
        log.warn('enqueueTicket threw during startup sweep', {
          noteId: row.id,
          folderId: row.folder_id,
          error: (err as Error).message,
        });
        summary.rejected['threw'] = (summary.rejected['threw'] ?? 0) + 1;
      }
    }

    // Per-folder marker — set ONLY when no throws. Rejections are
    // deterministic gate failures; a throw is a transient error
    // we don't want to forget about.
    if (!folderHadThrow) {
      deps.workspaceSettings.set(markerKey, now);
    }
  }

  if (summary.audited > 0 || Object.keys(summary.rejected).length > 0) {
    log.info('auto-code startup sweep tick', {
      foldersScanned: enabledFolders.length,
      audited: summary.audited,
      enqueued: summary.enqueued,
      rejected: summary.rejected,
    });
  }
  return summary;
}

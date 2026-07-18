import type { AutoCodeDispatcher } from '../auto-code-factory/index.js';
import {
  AUTO_CODE_ACTOR_FILTER,
  AUTO_CODE_AUDIT_CHECKPOINT_KEY,
  TICK_BATCH_LIMIT,
  defaultLog,
  type AuditRow,
  type AutoCodeTickDeps,
  type EnqueueTickSummary,
} from './internals.js';
import { maybePostRejectionComment } from './rejection-comments.js';

/**
 * Rejections that are TRANSIENT — the ticket's `todo` trigger is still
 * unresolved rather than genuinely failed. If the card has since
 * settled back into `todo`, the checkpoint must NOT advance past the
 * triggering audit row, or the edge-triggered tick will never look at
 * the card again (an already-`todo` card emits no new status_change →
 * todo row).
 */
const TRANSIENT_REJECTION_REASONS: ReadonlySet<string> = new Set([
  'ticket_no_longer_todo',
  'cancelled_during_admission',
]);

/**
 * Incremental tick — process `status_change → todo` audit rows
 * since the stored checkpoint. Idempotent: dispatcher's atomic
 * admission collapses duplicate enqueues, so re-running with a
 * stale checkpoint can't double-trigger.
 *
 * Filtering rules:
 *   - `status_to = 'todo'` (the trigger we care about).
 *   - `actor != 'mcp:auto-code'` (don't echo our own moves —
 *     onRunStart fires todo→doing which would loop back as
 *     status_change).
 *   - Folder has `auto_code_enabled = 1` AND `enabled = 1`
 *     (Mo + auto-code both on). Cheap pre-filter that avoids the
 *     dispatcher's per-call gate evaluation on disabled folders.
 */
export async function runAutoCodeEnqueueTick(
  deps: AutoCodeTickDeps,
): Promise<EnqueueTickSummary> {
  const log = deps.log ?? defaultLog();

  const checkpoint = deps.workspaceSettings.get<number>(
    AUTO_CODE_AUDIT_CHECKPOINT_KEY,
    0,
  );

  // The filter catches BOTH transition paths into todo:
  //   - `status_change → todo` audit row (drag-and-drop, programmatic
  //      `tasks_move`, any path through `notes.moveToKanban`).
  //   - `create` audit row whose current note status is `todo` AND
  //     for which NO subsequent status_change row exists. The
  //     no-later-status-change clause matters: if the user created
  //     the note in the `note` column and auto-code (or someone
  //     else) later moved it to `todo`, the create row doesn't
  //     represent how the note arrived — only the latest
  //     status_change does. Without this guard, an
  //     `mcp:auto-code` status_change to `todo` would still get
  //     amplified by a parallel-matching user-authored create row,
  //     re-triggering the engine on its own move (echo loop).
  //
  // Dedupe by note_id (GROUP BY) so a single tick enqueues each
  // ticket once even when both audit rows exist (e.g. `create` →
  // `moveToKanban('todo')` produces both rows for the same note).
  // We keep `MAX(a.id)` so checkpoint advances past every matched
  // row in one go.
  //
  // The status-after-current check (`n.status = 'todo'` on the
  // create branch) makes the gate idempotent — if the user moved
  // the note out of todo between create and now, we don't enqueue.
  const auditRows = deps.db
    .prepare<[number, string, number], AuditRow>(
      `SELECT MAX(a.id) AS id, a.note_id, n.folder_id
         FROM audit_log a
         JOIN notes n ON n.id = a.note_id
         JOIN concierge_folder_settings cfs ON cfs.folder_id = n.folder_id
        WHERE a.id > ?
          AND (
                (a.action = 'status_change' AND a.status_to = 'todo')
             OR (
                  a.action = 'create'
                  AND n.status = 'todo'
                  AND NOT EXISTS (
                    SELECT 1 FROM audit_log a2
                     WHERE a2.note_id = a.note_id
                       AND a2.action = 'status_change'
                       AND a2.id > a.id
                  )
                )
          )
          AND a.actor != ?
          AND a.note_id IS NOT NULL
          AND n.deleted_at IS NULL
          AND n.archived_at IS NULL
          AND cfs.auto_code_enabled = 1
          AND cfs.enabled = 1
          AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
        GROUP BY a.note_id, n.folder_id
        ORDER BY MAX(a.id) ASC
        LIMIT ?`,
    )
    .all(checkpoint, AUTO_CODE_ACTOR_FILTER, TICK_BATCH_LIMIT);

  const summary: EnqueueTickSummary = {
    audited: auditRows.length,
    enqueued: 0,
    rejected: {},
    newCheckpoint: checkpoint,
  };

  if (auditRows.length === 0) return summary;

  let dispatcher: AutoCodeDispatcher | null = null;
  let maxId = checkpoint;
  // Smallest audit-row id whose enqueue was TRANSIENTLY rejected while
  // the ticket is still in `todo`. Keeps the checkpoint below it so the
  // next tick retries — the anti-strand guard (see TRANSIENT_REJECTION_REASONS).
  let holdBeforeId: number | null = null;
  const noteStatusStmt = deps.db.prepare<[string], { status: string }>(
    'SELECT status FROM notes WHERE id = ? AND deleted_at IS NULL',
  );
  for (const row of auditRows) {
    if (!dispatcher) {
      try {
        dispatcher = await deps.buildDispatcher();
      } catch (err) {
        log.warn('buildDispatcher threw', { error: (err as Error).message });
        // CRITICAL: do NOT advance maxId here. Earlier code advanced
        // before buildDispatcher ran, so a transient throw
        // (e.g. claude not yet detected at startup) lost the row
        // from the checkpoint forever. Now break BEFORE bumping —
        // the next tick re-reads from the same checkpoint position.
        break;
      }
    }
    // Advance only once we have a working dispatcher and are
    // committed to processing this row. enqueueTicket throws still
    // advance (we count them as `rejected.threw` and don't want to
    // loop on a permanently-broken ticket), but pre-dispatcher
    // failures don't.
    if (row.id > maxId) maxId = row.id;
    try {
      const out = await dispatcher.enqueueTicket(row.note_id, row.folder_id);
      if (out.kind === 'enqueued') {
        summary.enqueued += 1;
      } else {
        summary.rejected[out.reason] = (summary.rejected[out.reason] ?? 0) + 1;
        // Fix B (ticket 01KRFPCCZBC40ATQCHY1FPJ8KP): surface the
        // rejection as a visible comment so the user isn't left with
        // a ticket silently stuck in `todo`. Dedup'd to one
        // comment / 24h per ticket to avoid spam on persistent issues.
        maybePostRejectionComment(deps, row.note_id, out, Date.now());
        // Anti-strand: a transient rejection (toggle race) on a card
        // that is now back in `todo` must not let the checkpoint pass
        // this row, or the card is never re-examined. Hold below it so
        // the next tick retries; once the card is stably `todo` the
        // retry enqueues and the checkpoint advances normally. A card
        // that genuinely left `todo` isn't held (status != 'todo').
        if (
          TRANSIENT_REJECTION_REASONS.has(out.reason) &&
          noteStatusStmt.get(row.note_id)?.status === 'todo'
        ) {
          holdBeforeId =
            holdBeforeId === null ? row.id : Math.min(holdBeforeId, row.id);
        }
      }
    } catch (err) {
      log.warn('enqueueTicket threw', {
        noteId: row.note_id,
        folderId: row.folder_id,
        error: (err as Error).message,
      });
      summary.rejected['threw'] = (summary.rejected['threw'] ?? 0) + 1;
    }
  }

  const nextCheckpoint =
    holdBeforeId !== null ? Math.min(maxId, holdBeforeId - 1) : maxId;
  if (nextCheckpoint > checkpoint) {
    deps.workspaceSettings.set(AUTO_CODE_AUDIT_CHECKPOINT_KEY, nextCheckpoint);
    summary.newCheckpoint = nextCheckpoint;
  }

  if (summary.enqueued > 0 || Object.keys(summary.rejected).length > 0) {
    log.info('auto-code enqueue tick', {
      audited: summary.audited,
      enqueued: summary.enqueued,
      rejected: summary.rejected,
      checkpoint: summary.newCheckpoint,
    });
  }
  return summary;
}

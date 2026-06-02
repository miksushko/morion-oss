import type { CancelSummary } from '../../../core/auto-code/toggle-killer.js';

/** Workflow-runner enqueue result, unified at the dispatcher boundary.
 *  Legacy engine has been retired (ticket `01KRB0W7CV1PF48YD8FF6J14DG`);
 *  the `engine` discriminator is gone — every successful enqueue lands
 *  in `workflow_runs` via the runner. `deduped: true` marks a no-op
 *  enqueue against an in-flight run for the same ticket. */
export type UnifiedEnqueueResult =
  | {
      kind: 'enqueued';
      runId: string;
      deduped?: boolean;
    }
  | { kind: 'rejected'; reason: string; missingDetails?: readonly string[] };

export interface InflightOverview {
  /** Combined non-terminal count across legacy `mo_agent_queue` AND
   *  new `workflow_runs`. Legacy rows from before retirement may still
   *  exist; cancel/inflight paths keep draining them until the table
   *  is empty. Surfaced in toggle-off confirmation popup. */
  count: number;
  /** Task titles for UI rendering ("3 tickets are running:\n - X ..."). */
  taskTitles: string[];
}

export interface UnifiedCancelSummary {
  /** Legacy-side cleanup (mo_agent_queue rows from pre-retirement runs).
   *  NULL when no legacy rows existed. */
  legacy: CancelSummary | null;
  /** Workflow-runner cancellations. Lists workflow_run ids that were
   *  signalled (cancel_requested + adapter cancel). */
  workflowRunIds: string[];
}

export interface AutoCodeDispatcher {
  /** Workflow runner is the only engine now (ticket
   *  `01KRB0W7CV1PF48YD8FF6J14DG`). Field retained for UI back-compat
   *  (Auto-Code budget panel reads it); always `true`. */
  readonly isWorkflowRunner: boolean;
  enqueueTicket(noteId: string, folderId: string): Promise<UnifiedEnqueueResult>;
  /** Cancel any active work for `(folderId, ticketId)` — fans out
   *  across `workflow_runs` (new) AND `mo_agent_queue` (legacy rows
   *  that pre-date retirement) so engine-toggle history doesn't
   *  leak orphans. No-op when nothing in flight. */
  cancelTicket(
    folderId: string,
    ticketId: string,
    reason?: string,
  ): Promise<UnifiedCancelSummary>;
  /** Cancel every active ticket in the folder. Used by the toggle-off
   *  killer; spans both tables for the same reason. */
  cancelFolder(
    folderId: string,
    reason?: string,
  ): Promise<UnifiedCancelSummary>;
  /** Combined in-flight count + task titles across both tables.
   *  Powers the pre-toggle-off confirmation popup. */
  inflightOverview(folderId: string): InflightOverview;
  /** Phase 5 (Human-in-Loop) — fire the runner's resume hook when a
   *  user reply lands in a workflow-linked Ask Mo session. Resume is
   *  fire-and-forget from the caller's POV; the runner re-enters
   *  dispatch asynchronously and posts further updates via ticket
   *  comments. */
  resumeFromHumanGate?(input: {
    runId: string;
    userReply: string;
  }): Promise<void>;
}

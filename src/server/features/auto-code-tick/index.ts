/**
 * Auto-code Workflow Builder L2.T7.B.2.d — trigger reliability.
 *
 * The legacy autocode loop's only trigger was the `/api/notes/:id/
 * kanban-move` HTTP route, which fires on user-driven drag-and-drop.
 * Every other path that lands a ticket in `todo` — programmatic
 * move via MCP `tasks_move`, `notes_create` with initial
 * `status: 'todo'`, pre-existing `todo` cards present at the moment
 * the user enables the auto-code engine — silently bypassed the
 * trigger. Real productization gap: the user's mental model is
 * "ticket in todo + auto-code on → it gets worked on", which the
 * old code only partially honoured.
 *
 * This module ships two complementary sweepers that together close
 * the gap:
 *
 *   1. `runAutoCodeEnqueueTick` — incremental audit-log polling.
 *      Reads `audit_log` rows since a stored checkpoint where
 *      `action='status_change' AND status_to='todo'` and enqueues
 *      each. Catches every code path that records a status change,
 *      including programmatic moves + the kanban-move route itself
 *      (so the route's inline trigger could eventually be removed
 *      in favour of this single subscriber).
 *
 *   2. `runAutoCodeStartupSweep` — one-shot full scan. Selects
 *      every ticket currently in `status='todo'` for an auto-code-
 *      enabled folder that has NO active workflow run AND no active
 *      legacy queue row, and enqueues them. Catches the
 *      "prepared the board, then enabled the engine" case where
 *      tickets pre-date the audit log's status_change rows.
 *
 * Both rely on the orchestrator's atomic admission + per-folder
 * concurrency cap to safely no-op duplicate enqueues. The dispatcher's
 * own dedupe path makes calling enqueueTicket on a ticket that
 * already has an active run cheap (returns deduped=true without
 * touching git or claude).
 *
 * Composition barrel — all logic lives in `./auto-code-tick/`:
 *   - `internals.ts`           shared constants + types + log default.
 *   - `rejection-comments.ts`  buildRejectionCommentBody + post helper.
 *   - `enqueue-tick.ts`        runAutoCodeEnqueueTick (incremental).
 *   - `startup-sweep.ts`       runAutoCodeStartupSweep (per-folder).
 *
 * Per the 2026-05-16 split (Morion ticket 01KRQYVA7GSM8W77J94JB2P615),
 * importers should keep using `src/server/features/auto-code-tick/index.js` — this
 * barrel preserves the pre-split public surface verbatim.
 */
export {
  AUTO_CODE_AUDIT_CHECKPOINT_KEY,
  AUTO_CODE_FOLDER_SWEEP_DONE_KEY_PREFIX,
  AUTO_CODE_STARTUP_SWEEP_DONE_KEY,
  type AutoCodeTickDeps,
  type EnqueueTickSummary,
} from './internals.js';
export { runAutoCodeEnqueueTick } from './enqueue-tick.js';
export { runAutoCodeStartupSweep } from './startup-sweep.js';

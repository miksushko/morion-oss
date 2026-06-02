/**
 * Shared auto-code identity constants used by the workflow runner
 * (and historically by the legacy orchestrator under retirement —
 * ticket `01KRB0W7CV1PF48YD8FF6J14DG`). Lifted out of the
 * `orchestrator/` subdirectory so the workflow stack has a neutral
 * import home that survives the legacy stack's deletion.
 */

/** Actor stamped on every audit row written by an auto-code agent
 *  on behalf of a workflow run. Discriminator for permission gates
 *  + audit-log filters that need to tell "user wrote this" from
 *  "auto-code wrote this on the user's behalf". */
export const AUTO_CODE_ACTOR = 'mcp:auto-code';

/** Sticky tag added to a ticket when the workflow runner pauses
 *  for human input (paused_ask_user). Removed on resume. UI uses
 *  it to render the "Awaiting your answer" pill in the kanban
 *  card without re-querying workflow_runs. */
export const AUTO_CODE_PAUSED_TAG = 'auto-code-paused';

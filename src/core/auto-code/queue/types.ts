/**
 * Public types + state-set constants + concurrency caps for the auto-code
 * queue. Extracted from `../queue.ts` (2026-05-16, ticket
 * `01KRQYRP1KPN25W5F4PTC7E9XJ`).
 */

export type AgentQueueState =
  | 'pending'
  | 'fix_running'
  | 'fix_review'
  | 'review_running'
  | 'reopened'
  | 'done'
  // Workflow-runner-only state — set by `projectWorkflowRunAsQueue`
  // when the user merges a `done` run's worktree branch into main
  // via the AutoCodeDrawer button. Legacy queue rows (mo_agent_queue)
  // NEVER carry this state; it lives in the union solely so the
  // API surface that unifies both engines can express the post-merge
  // shape without a wider type union at every callsite.
  | 'done_merged'
  // Workflow-runner-only state — Phase 5 (ticket
  // 01KRFT0742GY480WFJTAW02Z05). When the DAG runner hits a
  // `human_gate` stage it pauses the run + opens an Ask Mo chat
  // session. The kanban badge surfaces this as
  // "awaiting your reply" so the user knows they need to act in
  // chat. Legacy queue rows NEVER carry this state.
  | 'paused_ask_user'
  | 'failed'
  | 'cancelled';

export const TERMINAL_STATES: ReadonlySet<AgentQueueState> = new Set([
  'done',
  'failed',
  'cancelled',
]);

/** States that hold a live `claude`/`codex` child process (active_pid
 *  is expected to be non-null). Used by stale-recovery + toggle-off. */
export const RUNNING_STATES: ReadonlySet<AgentQueueState> = new Set([
  'fix_running',
  'review_running',
]);

/** States that count against `MAX_INFLIGHT` per folder. Pending counts
 *  too — once we admit a ticket we owe it a slot, even before the
 *  worker picks it up. */
export const IN_FLIGHT_STATES: ReadonlySet<AgentQueueState> = new Set([
  'pending',
  'fix_running',
  'fix_review',
  'review_running',
  'reopened',
]);

export const MAX_INFLIGHT_PER_FOLDER = 5;

/** Stale-recovery escalates to `failed` after this many forced
 *  releases. Independent of LLM-side retry count (the launcher itself
 *  may retry inside one attempt for transient errors). */
export const MAX_ATTEMPTS_BEFORE_FAILED = 3;

export interface AgentQueueRow {
  id: string;
  folderId: string;
  taskId: string;
  state: AgentQueueState;
  attempts: number;
  reopenCount: number;
  repoPath: string;
  worktreeName: string | null;
  fixSessionId: string | null;
  reviewSessionId: string | null;
  lastVerdict: string | null;
  lastError: string | null;
  activePid: number | null;
  sessionGroupId: string | null;
  claimedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueOptions {
  folderId: string;
  taskId: string;
  repoPath: string;
  /** Optional override; defaults to the row's own `id`. The
   *  related-tickets share-session optimisation in #15 sets this to
   *  the existing in-flight session's group id. */
  sessionGroupId?: string;
  now?: number;
}

export type EnqueueResult =
  | { kind: 'inserted'; row: AgentQueueRow }
  | { kind: 'deduped'; existing: AgentQueueRow };

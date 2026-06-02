/**
 * Auto-code workflow_runs → AutoCodeQueueRow projection + repo path validators
 * + run resolver. Extracted from `../shared.ts` (2026-05-16, ticket
 * `01KRQYS1T925XEWBBJJYRJBGE2`).
 */

import { statSync } from 'node:fs';
import { isAbsolute as isAbsolutePath } from 'node:path';
import { AgentQueueRepository } from '../../../../core/auto-code/queue.js';
import { WorkflowRunsRepository } from '../../../../core/auto-code/workflows/runs-repository.js';
import type { WorkflowRunRow } from '../../../../core/auto-code/workflows/types/index.js';
import type { ToolContext } from '../../../tools/types.js';

/**
 * Project a `WorkflowRunRow` into the `AutoCodeQueueRow` shape the
 * kanban-card badge component expects. Lets the badge endpoint
 * union legacy `mo_agent_queue` rows with new `workflow_runs` rows
 * without a UI rewrite.
 *
 * State mapping (workflow_runs → AutoCodeQueueState):
 *   pending           → 'pending'
 *   running           → 'fix_running' (closest "in flight" state)
 *   paused_ask_user   → 'fix_running' (still in-flight from UX POV)
 *   done              → 'done'
 *   failed            → 'failed'
 *   cancelled         → 'cancelled'
 *
 * Fields the workflow_runs schema doesn't track (reopen count,
 * fix/review session ids, active_pid) are filled with safe defaults
 * — the badge surface doesn't use them, the drawer does (separate
 * route).
 */
export function projectWorkflowRunAsQueue(
  run: WorkflowRunRow,
  runsRepo?: WorkflowRunsRepository,
): {
  id: string;
  folderId: string;
  taskId: string;
  state:
    | 'pending'
    | 'fix_running'
    | 'fix_review'
    | 'review_running'
    | 'reopened'
    | 'done'
    | 'done_merged'
    | 'failed'
    | 'cancelled'
    | 'paused_ask_user';
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
} {
  let state:
    | 'pending'
    | 'fix_running'
    | 'done'
    | 'done_merged'
    | 'failed'
    | 'cancelled'
    | 'paused_ask_user';
  switch (run.status) {
    case 'pending':
      state = 'pending';
      break;
    case 'running':
      state = 'fix_running';
      break;
    case 'paused_ask_user':
      // Phase 5 — surface paused state distinctly so the kanban
      // badge can flip to "awaiting your reply" + the drawer can
      // expose the linked chat. Without this, paused runs looked
      // identical to in-flight ones — user couldn't tell they
      // needed to do something.
      state = 'paused_ask_user';
      break;
    case 'done':
      // Promote `done` -> `done_merged` once the user clicked the
      // AutoCodeDrawer "Merge into main" button (`merged_at` non-null).
      // Hides the merge button on subsequent drawer opens AND surfaces
      // a distinct "auto-done · merged" kanban badge so the user can
      // tell at a glance which auto-code runs already landed in main.
      state = run.mergedAt != null ? 'done_merged' : 'done';
      break;
    case 'cancelled':
      state = 'cancelled';
      break;
    case 'failed':
    default:
      state = 'failed';
      break;
  }
  // Worktree name comes from the worktree path suffix
  // (`.morion/worktrees/auto-XXX` — pre-rename runs may carry
  // `.claude/worktrees/auto-XXX`; `pop()` returns the leaf either way).
  const worktreeName = run.worktreePath.split('/').pop() ?? null;
  // Pull session ids from the run's stage rows (when the caller
  // supplied a repo for cross-table lookup). First cli_agent stage
  // = "fix" session, second = "review". Surface these so the
  // AutoCodeDrawer's "Resume in terminal" affordance + transcript
  // pane have something to chew on; transcript path resolution for
  // workflow runs lives at `~/.morion/runs/<sessionId>.jsonl` (vs
  // legacy `~/.claude/projects/<encoded>/<sessionId>.jsonl`) — that
  // resolver follow-up is parked.
  let fixSessionId: string | null = null;
  let reviewSessionId: string | null = null;
  if (runsRepo) {
    const stages = runsRepo.listStagesForRun(run.id);
    const cliStages = stages.filter(
      (s) => s.stageKind === 'cli_agent' && s.sessionId !== null,
    );
    fixSessionId = cliStages[0]?.sessionId ?? null;
    reviewSessionId = cliStages[1]?.sessionId ?? null;
  }
  return {
    id: run.id,
    folderId: run.folderId,
    taskId: run.ticketId,
    state,
    attempts: 1,
    reopenCount: 0,
    repoPath: run.repoPath,
    worktreeName,
    fixSessionId,
    reviewSessionId,
    lastVerdict: null,
    lastError: run.lastError,
    activePid: null,
    sessionGroupId: null,
    claimedAt: run.startedAt,
    createdAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
}

/**
 * Auto-code linked-repo validator. Sanity-checks the path BEFORE the
 * repo layer accepts it, so the DB never holds a path that isn't a
 * real git checkout. Symlinks are resolved by `statSync` so a symlinked
 * repo works. Worktrees count: `.git` is a file pointing at the parent
 * gitdir, but `statSync` only cares it exists.
 */
export function validateLinkedRepo(
  path: string,
): { ok: true } | { ok: false; error: string } {
  if (!isAbsolutePath(path)) {
    return { ok: false, error: 'Path must be absolute (start with /).' };
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return { ok: false, error: 'Path does not exist on this machine.' };
  }
  if (!st.isDirectory()) {
    return { ok: false, error: 'Path is not a directory.' };
  }
  try {
    statSync(`${path}/.git`);
  } catch {
    return { ok: false, error: 'Directory is not a git repository (no .git entry).' };
  }
  return { ok: true };
}

/** Resolve an auto-code run id (workflow_runs row OR legacy
 *  mo_agent_queue row) into its `{repoPath, worktreeName}` pair —
 *  shared bootstrap for the merge / files / files-content routes
 *  which all need the same lookup + error envelope shape. */
export function resolveAutoCodeRunWorktree(
  ctx: ToolContext,
  runId: string,
):
  | { ok: true; repoPath: string; worktreeName: string; ticketId: string }
  | {
      ok: false;
      body: { ok: false; error: string; message: string };
      status: 404 | 500;
    } {
  const wfRepo = new WorkflowRunsRepository(ctx.db);
  const run = wfRepo.getRun(runId);
  if (run) {
    const worktreeName = run.worktreePath.split('/').pop() ?? '';
    if (!worktreeName) {
      return {
        ok: false,
        body: {
          ok: false,
          error: 'invalid_worktree_path',
          message: `Could not derive worktree name from ${run.worktreePath}.`,
        },
        status: 500,
      };
    }
    return { ok: true, repoPath: run.repoPath, worktreeName, ticketId: run.ticketId };
  }
  const agentQueue = new AgentQueueRepository(ctx.db);
  const legacyRow = agentQueue.getById(runId);
  if (!legacyRow) {
    return {
      ok: false,
      body: { ok: false, error: 'run_not_found', message: `Run ${runId} not found.` },
      status: 404,
    };
  }
  if (!legacyRow.worktreeName) {
    return {
      ok: false,
      body: { ok: false, error: 'no_worktree', message: 'Legacy queue row has no worktree.' },
      status: 500,
    };
  }
  return {
    ok: true,
    repoPath: legacyRow.repoPath,
    worktreeName: legacyRow.worktreeName,
    ticketId: legacyRow.taskId,
  };
}

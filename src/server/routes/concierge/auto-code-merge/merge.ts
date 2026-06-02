/**
 * POST /api/auto-code/runs/:id/merge
 *
 * Happy-path merge of an auto-code worktree branch → trunk. Powers
 * the "Merge into main" button in AutoCodeDrawer for runs in the
 * `done` state. Reads the workflow_run row to compute the per-run
 * feature branch (`worktree-auto-XXX`), then runs
 * `git checkout <target> && git merge <branch>` in the repo's main
 * checkout.
 *
 * Body: `{ targetBranch?: string, strategy?: 'ff-only' | 'no-ff' | 'auto' }`.
 * Defaults: target = auto-detect main/master, strategy = 'no-ff'
 * (preserves auto-code branch in history).
 */
import type { Context, Hono } from 'hono';
import { mergeWorktreeIntoTarget } from '../../../../core/auto-code/merge.js';
import { AUTO_CODE_ACTOR } from '../../../../core/auto-code/actor-constants.js';
import { WorkflowRunsRepository } from '../../../../core/auto-code/workflows/runs-repository.js';
import type { ToolContext } from '../../../tools/types.js';

export function registerMergeRoute(app: Hono, ctx: ToolContext): void {
  // Extract `:id` at the registration site so Hono's path-literal
  // narrowing returns `string` (not `string | undefined`) — same
  // pattern as the rest of the auto-code-merge handlers.
  app.post('/api/auto-code/runs/:id/merge', (c) =>
    handleMerge(c, ctx, c.req.param('id')),
  );
}

async function handleMerge(c: Context, ctx: ToolContext, runId: string) {
  const wfRepo = new WorkflowRunsRepository(ctx.db);
  const run = wfRepo.getRun(runId);
  if (!run) {
    // Legacy `mo_agent_queue` rows aren't supported — they pre-date
    // the worktree-merge affordance and their cleanup path doesn't
    // preserve the branch. Surface a clean 404 with hint.
    return c.json(
      {
        error: 'run_not_found',
        message: `Workflow run ${runId} not found. Legacy auto-code queue rows aren't merge-able through this endpoint — merge them manually in the terminal.`,
      },
      404,
    );
  }
  if (run.status !== 'done') {
    return c.json(
      {
        error: 'run_not_done',
        message: `Run is in state "${run.status}" — only "done" runs can be merged. Re-run auto-code or manually merge the worktree.`,
      },
      422,
    );
  }
  const body = await c.req.json().catch(() => ({}));
  const targetBranch =
    typeof body?.targetBranch === 'string' && body.targetBranch.length > 0
      ? body.targetBranch
      : undefined;
  const strategy =
    body?.strategy === 'ff-only' || body?.strategy === 'auto'
      ? body.strategy
      : 'no-ff';

  // worktreeName = last segment of worktreePath (works for both
  // `.morion/worktrees/auto-XXX` and legacy `.claude/worktrees/auto-XXX`).
  const worktreeName = run.worktreePath.split('/').pop() ?? '';
  if (!worktreeName) {
    return c.json(
      {
        error: 'invalid_worktree_path',
        message: `Could not derive worktree name from ${run.worktreePath}.`,
      },
      500,
    );
  }
  const result = await mergeWorktreeIntoTarget({
    repoPath: run.repoPath,
    worktreeName,
    targetBranch,
    strategy,
  });
  if (!result.ok) {
    const httpStatus =
      result.error === 'repo_not_found' ||
      result.error === 'target_branch_missing' ||
      result.error === 'worktree_branch_missing'
        ? 404
        : result.error === 'working_tree_dirty' ||
            result.error === 'same_branch' ||
            result.error === 'merge_conflict'
          ? 409
          : 500;
    return c.json(
      { error: result.error, message: result.message },
      httpStatus,
    );
  }
  // Stamp merged_at so the kanban badge promotes to `done_merged` and
  // the drawer hides the Merge button on next open. Idempotent — the
  // repo helper skips the UPDATE when merged_at is already set.
  wfRepo.markMerged(runId);
  // Drop a Mo footprint comment on the ticket so the activity feed
  // outside the drawer also shows the merge. Without this, the
  // "merged" signal only lives in the drawer's status pill — users
  // scanning the activity tab on a ticket see "Auto-code complete"
  // but no confirmation that the changes actually landed in their
  // code. Comments are advisory — wrap in try/catch so a comment
  // write failure can't sink the (already-successful) merge HTTP
  // response.
  try {
    const stat = result.stat ? ` (${result.stat})` : '';
    const filesChanged = result.autoCommitted?.filesChanged ?? 0;
    const commitNote = result.autoCommitted
      ? `\n\nMo also committed ${filesChanged} file${filesChanged === 1 ? '' : 's'} on the worktree branch before merge as \`${result.autoCommitted.sha}\` — the agent wrote code but didn't \`git commit\` itself.`
      : '';
    ctx.comments.create(
      run.ticketId,
      `✓ Merged into \`${result.targetBranch}\`. Branch \`${result.mergedBranch}\` → \`${result.targetBranch}\`${stat}.\n\nThe files are now on your trunk checkout. Open the repo via **Show files** in the drawer, or jump straight into your editor.${commitNote}`,
      AUTO_CODE_ACTOR,
      null,
    );
  } catch (err) {
    console.error('[merge-route] post-merge comment failed:', err);
  }
  return c.json(result);
}

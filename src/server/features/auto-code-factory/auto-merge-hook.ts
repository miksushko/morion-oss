import type { ToolContext } from '../../tools/types.js';
import type { WorkflowRunsRepository } from '../../../core/auto-code/workflows/runs-repository.js';
import type { WorkflowRunRow } from '../../../core/auto-code/workflows/types/index.js';
import { AUTO_CODE_ACTOR } from '../../../core/auto-code/actor-constants.js';
import { readFolderAutoMerge } from '../../features/auto-code-template-settings.js';

/**
 * Build the `autoMergeAfterDone` hook for WorkflowOrchestrator.
 * Honours the per-folder `auto_code.auto_merge.<folderId>` setting:
 * when on, fires `mergeWorktreeIntoTarget` right after the run flips
 * to done and posts a "✓ Auto-merged into <target>" footprint. When
 * off (default), this is a no-op — the user merges manually via the
 * drawer's "Merge into main" button.
 *
 * Errors surface as a ticket comment but don't break the run (it's
 * already done). Three failure shapes: missing worktree name,
 * `mergeWorktreeIntoTarget` threw, `mergeWorktreeIntoTarget` returned
 * `!ok` — each gets its own comment.
 */
export function buildAutoMergeHook(deps: {
  toolCtx: ToolContext;
  runsRepo: WorkflowRunsRepository;
}): (run: WorkflowRunRow) => Promise<void> {
  const { toolCtx, runsRepo } = deps;
  return async (run) => {
    if (!readFolderAutoMerge(toolCtx.settings, run.folderId)) return;
    const worktreeName = run.worktreePath.split('/').pop() ?? '';
    if (!worktreeName) {
      toolCtx.comments.create(
        run.ticketId,
        `⚠️ Auto-merge didn't start: couldn't derive worktree name from \`${run.worktreePath}\`. Merge manually via **Merge into main** in the drawer.`,
        AUTO_CODE_ACTOR,
        null,
      );
      return;
    }
    const { mergeWorktreeIntoTarget } = await import(
      '../../../core/auto-code/merge.js'
    );
    let result;
    try {
      result = await mergeWorktreeIntoTarget({
        repoPath: run.repoPath,
        worktreeName,
        strategy: 'no-ff',
      });
    } catch (err) {
      toolCtx.comments.create(
        run.ticketId,
        `⚠️ Auto-merge crashed: ${(err as Error).message ?? String(err)}\n\nRetry manually via **Merge into main** in the drawer.`,
        AUTO_CODE_ACTOR,
        null,
      );
      return;
    }
    if (!result.ok) {
      toolCtx.comments.create(
        run.ticketId,
        `⚠️ Auto-merge failed (${result.error}): ${result.message}\n\nThe changes are still on the branch — open the drawer and retry via **Merge into main**, or inspect \`${run.repoPath}\` to see what's wrong.`,
        AUTO_CODE_ACTOR,
        null,
      );
      return;
    }
    runsRepo.markMerged(run.id);
    const stat = result.stat ? ` (${result.stat})` : '';
    const filesChanged = result.autoCommitted?.filesChanged ?? 0;
    const commitNote = result.autoCommitted
      ? `\n\nMo also committed ${filesChanged} file${filesChanged === 1 ? '' : 's'} on the worktree branch before merge as \`${result.autoCommitted.sha}\` — the agent wrote code but didn't \`git commit\` itself.`
      : '';
    toolCtx.comments.create(
      run.ticketId,
      `✓ Auto-merged into \`${result.targetBranch}\`. Branch \`${result.mergedBranch}\` → \`${result.targetBranch}\`${stat}.\n\nThe files are now on your trunk checkout. Open the repo via **Show files** in the drawer, or jump straight into your editor.${commitNote}`,
      AUTO_CODE_ACTOR,
      null,
    );
  };
}

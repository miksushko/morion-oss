/**
 * POST /api/auto-code/runs/:id/merge-conflict-prepare
 *
 * Attempts the merge with `abortOnConflict=false`; on conflict returns
 * the per-file ours/theirs/merged content needed by the editor. On
 * clean merge, returns `{ok: true, clean: true}` with no conflict
 * files (caller's modal can flip straight to done_merged).
 *
 * Serialised per-repo via the shared `RepoMergeLock` — see
 * `repo-merge-lock.ts` for the StrictMode-race incident this guards
 * against.
 */
import type { Context, Hono } from 'hono';
import { worktreeBranchName } from '../../../../core/auto-code/worktree-paths.js';
import { mergeWorktreeIntoTarget } from '../../../../core/auto-code/merge.js';
import {
  detectActiveCommitHooks,
  readMergeConflictState,
} from '../../../../core/auto-code/merge-conflict-resolver.js';
import { WorkflowRunsRepository } from '../../../../core/auto-code/workflows/runs-repository.js';
import type { ToolContext } from '../../../tools/types.js';
import { resolveAutoCodeRunWorktree } from '../shared.js';
import type { RepoMergeLock } from './repo-merge-lock.js';

export function registerPrepareRoute(
  app: Hono,
  ctx: ToolContext,
  withRepoMergeLock: RepoMergeLock,
): void {
  app.post('/api/auto-code/runs/:id/merge-conflict-prepare', (c) =>
    handlePrepare(c, ctx, withRepoMergeLock, c.req.param('id')),
  );
}

async function handlePrepare(
  c: Context,
  ctx: ToolContext,
  withRepoMergeLock: RepoMergeLock,
  runId: string,
) {
  const resolved = resolveAutoCodeRunWorktree(ctx, runId);
  if (!resolved.ok) return c.json(resolved.body, resolved.status);

  // Serialise per-repo to prevent React StrictMode's double-fire (and
  // any other concurrent caller) from racing two merge ops.
  return withRepoMergeLock(resolved.repoPath, async () => {
    const wfRepo = new WorkflowRunsRepository(ctx.db);
    const run = wfRepo.getRun(runId);

    // Codex P1.4 — gate prepare/apply on the same `done` status the
    // regular /merge route requires. Without this, a caller could
    // start a merge on a still-running OR cancelled OR failed run
    // and trash trunk state. Legacy `mo_agent_queue` rows aren't
    // surfaced via workflow_runs so we accept them implicitly (the
    // resolver flow predates the run-status discriminator anyway).
    if (run && run.status !== 'done') {
      return c.json(
        {
          ok: false,
          error: 'run_not_done',
          message: `Run is in state "${run.status}" — only "done" runs can be merged. Re-run auto-code first.`,
        },
        409,
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

    // Codex P1.3 — recover existing mid-merge state. If MERGE_HEAD
    // already exists (sidecar restart between prepare and apply, OR
    // user closed the modal without applying or cancelling), the
    // existing conflict is what we should surface — re-running
    // mergeWorktreeIntoTarget would either abort our preserved state
    // (new merge.ts entry-guard auto-aborts stale MERGE_HEAD) or fail
    // with working_tree_dirty (older code path).
    //
    // Detection: read state. If inProgress AND mergeHeadRef points at
    // this run's worktree branch tip → reuse. Anything else (different
    // branch, or no merge in progress) → fall through to fresh attempt.
    const existing = await readMergeConflictState(resolved.repoPath);
    if (existing.ok && existing.inProgress) {
      // Resolve our worktree's actual branch tip — either bare name OR
      // legacy `worktree-<name>` prefix. Compare to MERGE_HEAD.
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const exec = promisify(execFile);
      let ourTip: string | null = null;
      for (const candidate of [
        resolved.worktreeName,
        worktreeBranchName(resolved.worktreeName),
      ]) {
        try {
          const r = await exec(
            'git',
            ['-C', resolved.repoPath, 'rev-parse', '--verify', '--quiet', candidate],
            { timeout: 5_000 },
          );
          ourTip = r.stdout.trim();
          break;
        } catch {
          // ignore — try next candidate.
        }
      }
      if (ourTip && ourTip === existing.mergeHeadRef) {
        // Same merge in progress — reuse without re-attempting.
        const hooks = detectActiveCommitHooks(resolved.repoPath);
        return c.json({
          ok: true,
          clean: false,
          conflict: {
            headRef: existing.headRef,
            mergeHeadRef: existing.mergeHeadRef,
            targetBranch: targetBranch ?? null,
            branchName: resolved.worktreeName,
            files: existing.files,
            rawMessage:
              '(recovered from existing MERGE_HEAD; the prior prepare call already produced this conflict state)',
            recovered: true,
            activeCommitHooks: hooks.hooks,
          },
        });
      }
      // Different branch's merge in progress — that's a state we
      // shouldn't disturb silently. Surface explicitly so the UI can
      // ask the user what to do (typically: cancel & abort, OR finish
      // the other merge first).
      return c.json(
        {
          ok: false,
          error: 'foreign_merge_in_progress',
          message: `Trunk is mid-merging a DIFFERENT branch (MERGE_HEAD=\`${existing.mergeHeadRef}\`, expected this run's branch \`${ourTip ?? resolved.worktreeName}\`). Cancel that merge first (\`git merge --abort\` in \`${resolved.repoPath}\`) or finish it before retrying.`,
        },
        409,
      );
    }

    const mergeResult = await mergeWorktreeIntoTarget({
      repoPath: resolved.repoPath,
      worktreeName: resolved.worktreeName,
      targetBranch,
      strategy,
      abortOnConflict: false,
    });

    // Happy path: merge succeeded, no conflict. Mirror the regular
    // merge route's done_merged handling so the UI can collapse the
    // resolver flow into "all done" without an extra round trip.
    if (mergeResult.ok) {
      if (run) wfRepo.markMerged(runId);
      return c.json({
        ok: true,
        clean: true,
        merge: mergeResult,
      });
    }

    // Conflict path: read state, return per-file content for the editor.
    if (mergeResult.error === 'merge_conflict') {
      const state = await readMergeConflictState(resolved.repoPath);
      if (!state.ok) {
        return c.json(
          { ok: false, error: state.error, message: state.message },
          500,
        );
      }
      if (!state.inProgress) {
        // Race: merge produced a conflict but the state was cleared
        // between the merge attempt and our read. Bail with a clear
        // error so the UI can surface "retry".
        return c.json(
          {
            ok: false,
            error: 'merge_state_lost',
            message:
              'Merge produced a conflict but MERGE_HEAD was cleared before we could read it. Retry the prepare call.',
          },
          500,
        );
      }
      const hooks = detectActiveCommitHooks(resolved.repoPath);
      return c.json({
        ok: true,
        clean: false,
        conflict: {
          headRef: state.headRef,
          mergeHeadRef: state.mergeHeadRef,
          targetBranch: targetBranch ?? null,
          branchName: resolved.worktreeName,
          files: state.files,
          rawMessage: mergeResult.message,
          activeCommitHooks: hooks.hooks,
        },
      });
    }

    // Other errors (working_tree_dirty, branch_missing, etc.) —
    // surface verbatim with the same HTTP status mapping the regular
    // merge route uses.
    const httpStatus =
      mergeResult.error === 'repo_not_found' ||
      mergeResult.error === 'target_branch_missing' ||
      mergeResult.error === 'worktree_branch_missing'
        ? 404
        : mergeResult.error === 'working_tree_dirty' ||
            mergeResult.error === 'same_branch'
          ? 409
          : 500;
    return c.json(
      { ok: false, error: mergeResult.error, message: mergeResult.message },
      httpStatus,
    );
  });
}

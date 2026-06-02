import { findWorktreePath, worktreeBranchName } from './worktree-paths.js';
import { commitWorktreeChanges } from './merge/commit-worktree.js';
import {
  abortStaleMerge,
  branchExists,
  detectMainBranch,
  execFileAsync,
  isWorkingTreeDirty,
  trimErr,
} from './merge/git-ops.js';

/**
 * Auto-code worktree merge helper (2026-05-11). Powers the
 * "Merge into main" affordance in AutoCodeDrawer: takes a workflow
 * run's repoPath + worktreeName, computes the per-run feature
 * branch (`worktree-auto-XXX`), and merges it into the user's
 * chosen target (defaults to `main`, falls back to `master`).
 *
 * Operates ONLY on the linked repo's main checkout — we never
 * touch the worktree directory itself except via `git worktree
 * remove` after a successful merge. The worktree's branch is
 * preserved on disk until the orchestrator's terminal-state hook
 * (or the next orphan sweep) reaps it.
 *
 * Safety invariants:
 *   - Working tree must be clean — uncommitted changes in the
 *     main checkout block the merge with a clear error. The user
 *     fixes by stashing / committing first.
 *   - Target branch must exist. We probe `main` → `master` →
 *     caller override. Unknown target → clean refusal.
 *   - Refuse to merge into the SAME branch the worktree is on
 *     (would be a no-op recursion in degenerate edge cases).
 *   - Conflicts surface as `{ok: false, error: 'merge_conflict'}`
 *     with stderr tail attached so the user can either resolve
 *     manually in their terminal or `git merge --abort`.
 *
 * Module layout (this file = orchestrator + types under the 500-LOC cap):
 *   - `./merge/git-ops.ts` — branchExists / detectMainBranch /
 *     isWorkingTreeDirty / abortStaleMerge / trimErr / execFileAsync
 *   - `./merge/commit-worktree.ts` — auto-commit dirty worktree
 *   - this file — public types + mergeWorktreeIntoTarget pipeline
 */

export interface MergeWorktreeArgs {
  repoPath: string;
  worktreeName: string;
  /** Override target branch. When omitted we auto-detect main /
   *  master in that order. */
  targetBranch?: string;
  /** Commit message used when the worktree has uncommitted changes
   *  the agent produced but didn't `git commit`. Empty / omitted →
   *  `"Auto-code: <worktreeName>"`. Pi / Codex / Claude write files
   *  to the worktree directory but don't auto-commit them; without
   *  this step the worktree branch HEAD stays at the parent commit
   *  and `git merge` reports "Already up to date" while the diff
   *  silently rots in the worktree's working tree. (2026-05-11). */
  commitMessage?: string;
  /** Strategy:
   *    - 'ff-only'   — fast-forward only. Refuses if branch
   *                    diverged. Safer; matches GitHub's
   *                    "merge fast-forward only" option.
   *    - 'no-ff'     — always create a merge commit. Preserves
   *                    branch topology so `git log --graph` shows
   *                    the auto-code feature branch.
   *    - 'auto'      — let git decide (default git merge).
   *  Default 'no-ff' — preserves history. */
  strategy?: 'ff-only' | 'no-ff' | 'auto';
  /** Optional commit message prefix for `--no-ff` strategy.
   *  Auto-fills with `Auto-code: merge <branch>` when omitted. */
  message?: string;
  /** When merge produces a conflict, should we `git merge --abort`
   *  before returning the error envelope? Default `true` —
   *  conservative, trunk left clean (zero accidental half-merge
   *  state). The manual conflict-resolver flow passes `false` so
   *  the MERGE_HEAD + UU files persist for the resolver UI to read
   *  them; the resolver is responsible for either applying the
   *  resolution via `merge-apply-resolution` (which completes the
   *  merge with the user's edits) or calling `merge-abort` on
   *  cancel. (2026-05-11) */
  abortOnConflict?: boolean;
}

export type MergeWorktreeResult =
  | {
      readonly ok: true;
      readonly targetBranch: string;
      readonly mergedBranch: string;
      readonly summary: string;
      /** Short stat (`X files changed, Y insertions(+), Z deletions(-)`). */
      readonly stat: string | null;
      /** Set when we had to commit uncommitted worktree changes
       *  before the merge could carry the agent's work. Surfaces
       *  in the UI so the user sees that an "auto-commit" landed
       *  alongside the merge — they may want to amend the message
       *  in their terminal. */
      readonly autoCommitted: {
        readonly sha: string;
        readonly filesChanged: number;
        readonly message: string;
      } | null;
    }
  | {
      readonly ok: false;
      readonly error:
        | 'repo_not_found'
        | 'target_branch_missing'
        | 'worktree_branch_missing'
        | 'working_tree_dirty'
        | 'same_branch'
        | 'merge_conflict'
        | 'git_error';
      readonly message: string;
    };

export async function mergeWorktreeIntoTarget(
  args: MergeWorktreeArgs,
): Promise<MergeWorktreeResult> {
  const strategy = args.strategy ?? 'no-ff';

  // Stale-merge cleanup. Trunk can land in mid-merge state if a
  // PRIOR attempt produced conflicts AND the prior sidecar didn't
  // run the auto-abort step (older builds, sidecar killed mid-flow,
  // or a non-MergeHelper code path entered the merge). Without this
  // guard, every subsequent merge attempt fails with:
  //   "Cannot save the current index state. fatal: stash failed"
  // OR:
  //   "Merging is not possible because you have unmerged files."
  // …trapping the user forever until they `git merge --abort` in
  // a terminal. Idempotent — no-op when no merge is in progress.
  // (Echo Drop incident 2026-05-12.)
  await abortStaleMerge(args.repoPath);

  // Two branch-naming conventions live in this codebase:
  //   - Legacy claude-launcher: `worktree-<worktreeName>` (claude's
  //     own `--worktree` flag prefixes branches that way).
  //   - Workflow runner: `<worktreeName>` verbatim (the orchestrator
  //     creates the branch via `git worktree add ... -b <sanitised>`
  //     and the sanitised name == the ULID-suffixed worktree name).
  // Probe both — pick whichever actually exists in this repo. Without
  // this branch-name divergence makes the merge endpoint always 404
  // for workflow runs (the user's primary path post-Phase-4.5).
  const candidates = [args.worktreeName, worktreeBranchName(args.worktreeName)];
  let mergedBranch: string | null = null;
  for (const c of candidates) {
    const r = await branchExists(args.repoPath, c);
    if (!r.ok) return r;
    if (r.exists) {
      mergedBranch = c;
      break;
    }
  }
  if (!mergedBranch) {
    return {
      ok: false,
      error: 'worktree_branch_missing',
      message: `Neither "${candidates[0]}" nor "${candidates[1]}" exists in repo ${args.repoPath}. The run's worktree may have been cleaned up before merge.`,
    };
  }

  // 2. Resolve target branch
  let targetBranch: string;
  if (args.targetBranch) {
    targetBranch = args.targetBranch;
    const exists = await branchExists(args.repoPath, targetBranch);
    if (!exists.ok) return exists;
    if (!exists.exists) {
      return {
        ok: false,
        error: 'target_branch_missing',
        message: `Target branch "${targetBranch}" not found in repo.`,
      };
    }
  } else {
    const detected = await detectMainBranch(args.repoPath);
    if (!detected) {
      return {
        ok: false,
        error: 'target_branch_missing',
        message: `Neither "main" nor "master" exists in the repo. Pass an explicit targetBranch.`,
      };
    }
    targetBranch = detected;
  }

  // 3. Same-branch guard
  if (targetBranch === mergedBranch) {
    return {
      ok: false,
      error: 'same_branch',
      message: `Cannot merge "${mergedBranch}" into itself.`,
    };
  }

  // 3.5. Auto-commit any uncommitted agent work in the worktree.
  // Worktree dir may not exist anymore (orphan cleanup ran, user
  // nuked it manually) — when absent we skip the commit step.
  let autoCommitted: {
    sha: string;
    filesChanged: number;
    message: string;
  } | null = null;
  const wtPath = findWorktreePath(args.repoPath, args.worktreeName);
  if (wtPath) {
    const commitResult = await commitWorktreeChanges(wtPath, {
      message:
        args.commitMessage ??
        `Auto-code: ${args.worktreeName}`,
    });
    if (!commitResult.ok) return commitResult;
    autoCommitted = commitResult.committed;
  }

  // 4. Working-tree-clean check (on the main checkout, NOT the
  //    worktree — the worktree was where the agent worked and
  //    its changes are now on the feature branch).
  const dirty = await isWorkingTreeDirty(args.repoPath);
  if (dirty.ok && dirty.dirty) {
    return {
      ok: false,
      error: 'working_tree_dirty',
      message: `Main repo working tree has uncommitted changes. Commit or stash them in ${args.repoPath} first, then retry.`,
    };
  }

  // 5. Switch to target branch
  try {
    await execFileAsync('git', ['-C', args.repoPath, 'checkout', targetBranch], {
      timeout: 30_000,
    });
  } catch (e) {
    return {
      ok: false,
      error: 'git_error',
      message: `git checkout "${targetBranch}" failed: ${trimErr(e)}`,
    };
  }

  // 6. Run the merge
  const mergeArgs = ['-C', args.repoPath, 'merge'];
  if (strategy === 'ff-only') mergeArgs.push('--ff-only');
  else if (strategy === 'no-ff') {
    mergeArgs.push('--no-ff');
    const msg = args.message ?? `Auto-code: merge ${mergedBranch} into ${targetBranch}`;
    mergeArgs.push('-m', msg);
  }
  mergeArgs.push(mergedBranch);
  let summary = '';
  try {
    const out = await execFileAsync('git', mergeArgs, { timeout: 60_000 });
    summary = (out.stdout + (out.stderr ? '\n' + out.stderr : '')).trim();
  } catch (e) {
    // `git merge` writes conflict markers ("CONFLICT (content):
    // Merge conflict in <file>" + "Automatic merge failed; fix
    // conflicts...") to STDOUT, not stderr. Combine both streams
    // for detection, then keep stderr as the primary user-facing
    // diagnostic.
    const errObj = e as { stderr?: string; stdout?: string; message?: string };
    const combined = [errObj.stdout, errObj.stderr, errObj.message]
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n');
    const stderr = trimErr(e);
    const isConflict =
      /CONFLICT|Automatic merge failed|Merge conflict/i.test(combined) ||
      /Aborting/i.test(combined);
    // Always try to leave the trunk checkout clean UNLESS the caller
    // asked us to preserve conflict state for the conflict-resolver
    // UI. `git merge` on failure leaves the working tree in mid-merge
    // state — `UU` conflicted files + `MERGE_HEAD` ref. Without an
    // abort, the next attempt at ANY merge refuses with "Merging is
    // not possible because you have unmerged files."
    const shouldAbort = args.abortOnConflict !== false || !isConflict;
    if (shouldAbort) {
      try {
        await execFileAsync('git', ['-C', args.repoPath, 'merge', '--abort'], {
          timeout: 10_000,
        });
      } catch {
        // Abort can legitimately fail when the merge never set
        // MERGE_HEAD (e.g. failed earlier in `git checkout` step).
      }
    }
    if (isConflict) {
      const conflictDetails = combined.trim() || stderr || '(no details emitted by git)';
      const stateLine = shouldAbort
        ? 'The half-merge state has been rolled back; your trunk is clean.'
        : 'The half-merge state has been PRESERVED (MERGE_HEAD + UU files left in place) so the conflict resolver can read them. The caller must either apply a resolution or call merge-abort to clean up.';
      return {
        ok: false,
        error: 'merge_conflict',
        message: `git merge produced conflicts. The auto-code branch diverged from \`${targetBranch}\` — likely another ticket merged between the time this run started and now, and both touched the same files. ${stateLine} To recover: re-run this ticket so the agent starts from the new \`${targetBranch}\` base, OR resolve the conflict manually in \`${args.repoPath}\` (\`git merge ${mergedBranch}\` then edit + \`git commit\`).\n\nConflict details:\n${conflictDetails}`,
      };
    }
    return {
      ok: false,
      error: 'git_error',
      message: `git merge "${mergedBranch}" → "${targetBranch}" failed: ${stderr || combined.trim() || '(no error output)'}`,
    };
  }

  // 7. Short stat for the user
  let stat: string | null = null;
  try {
    const r = await execFileAsync(
      'git',
      ['-C', args.repoPath, 'diff', '--shortstat', `${targetBranch}@{1}`, targetBranch],
      { timeout: 30_000 },
    );
    stat = r.stdout.trim() || null;
  } catch {
    stat = null;
  }

  // 8. Cleanup the merged worktree (ticket 01KRFX0PNE4WAFTDYJ3FQPK8F7).
  // Merge succeeded — agent's diff is now on `targetBranch`, so the
  // per-run worktree has no further purpose. Drop it via
  // `git worktree remove --force`. Best-effort: failed removal doesn't
  // invalidate the merge; the next orphan-sweep picks up whatever
  // survived. We do NOT delete the worktree branch — keeping the ref
  // leaves the merge graph inspectable via `git log --graph --all`.
  if (wtPath) {
    try {
      await execFileAsync(
        'git',
        ['-C', args.repoPath, 'worktree', 'remove', '--force', wtPath],
        { timeout: 30_000 },
      );
    } catch {
      // swallowed — see comment above
    }
  }

  return {
    ok: true,
    targetBranch,
    mergedBranch,
    summary,
    stat,
    autoCommitted,
  };
}

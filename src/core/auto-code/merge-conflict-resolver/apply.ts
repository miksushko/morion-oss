import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileAsync, trimErr } from './internal.js';
import {
  CONFLICT_MARKER_RE,
  type ApplyResolutionArgs,
  type ApplyResolutionResult,
} from './types.js';
import { readMergeConflictState } from './read-state.js';
import { validateSubmittedPaths } from './validate-paths.js';

/** Write the resolved file content to the worktree, stage, commit.
 *  Refuses if no MERGE_HEAD is set (would mean caller's preceding
 *  merge attempt either succeeded without conflict or was already
 *  aborted). */
export async function applyResolution(
  args: ApplyResolutionArgs,
): Promise<ApplyResolutionResult> {
  // Sanity: merge must be in progress.
  const state = await readMergeConflictState(args.repoPath);
  if (!state.ok) {
    return { ok: false, error: state.error, message: state.message };
  }
  if (!state.inProgress) {
    return {
      ok: false,
      error: 'no_merge_in_progress',
      message:
        'No merge is currently in progress. The merge may have been aborted or already completed.',
    };
  }

  // Path allowlist + binary + traversal hardening (Codex P1.1/P1.2).
  // See validate-paths.ts for the three-gate contract.
  const pathRejection = validateSubmittedPaths({
    repoPath: args.repoPath,
    resolvedFiles: args.resolvedFiles,
    files: state.files,
  });
  if (pathRejection !== null) return pathRejection;

  // Validate: no leftover conflict markers.
  const violators: string[] = [];
  for (const [path, content] of Object.entries(args.resolvedFiles)) {
    if (CONFLICT_MARKER_RE.test(content)) violators.push(path);
  }
  if (violators.length > 0) {
    return {
      ok: false,
      error: 'leftover_markers',
      message: `${violators.length} file(s) still contain conflict markers (\`<<<<<<<\` / \`=======\` / \`>>>>>>>\`). Resolve every conflict region before applying.`,
      violatingPaths: violators,
    };
  }

  // Write each resolved file's content to disk.
  const written: string[] = [];
  for (const [path, content] of Object.entries(args.resolvedFiles)) {
    try {
      writeFileSync(join(args.repoPath, path), content, 'utf8');
      written.push(path);
    } catch (err) {
      return {
        ok: false,
        error: 'git_error',
        message: `Failed to write resolved content to ${path}: ${trimErr(err)}`,
      };
    }
  }

  // Stage them all. We use `git add -- <paths>` so the index
  // entries for the previously-UU files collapse to a single
  // resolved-stage entry. (The user MIGHT have not touched some
  // UU files; if so, git commit will refuse below with "you must
  // resolve all conflicts" — surface that as leftover_markers.)
  try {
    await execFileAsync(
      'git',
      ['-C', args.repoPath, 'add', '--', ...written],
      { timeout: 30_000 },
    );
  } catch (err) {
    return {
      ok: false,
      error: 'git_error',
      message: `git add failed: ${trimErr(err)}`,
    };
  }

  // Check that no UU files remain — `git diff --name-only --diff-
  // filter=U` lists unmerged paths. If non-empty after our add,
  // the caller resolved only a subset of files.
  try {
    const r = await execFileAsync(
      'git',
      [
        '-C',
        args.repoPath,
        'diff',
        '--name-only',
        '--diff-filter=U',
      ],
      { timeout: 10_000 },
    );
    const remaining = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    if (remaining.length > 0) {
      return {
        ok: false,
        error: 'leftover_markers',
        message: `${remaining.length} file(s) still have unresolved conflicts in the index. Resolve every file before applying.`,
        violatingPaths: remaining,
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: 'git_error',
      message: `git diff --diff-filter=U check failed: ${trimErr(err)}`,
    };
  }

  // Defensive unstage of `.morion-harness.lock` before the merge
  // commit lands. Layer 3 of the lockfile-defence (see safety.ts
  // ensureLockfileIgnored for layer 1, merge.ts commitWorktreeChanges
  // for layer 2). The merge step propagates whatever was committed on
  // the worktree branch; agents that ran `git commit` themselves
  // BEFORE `.morion-harness.lock` was added to `.git/info/exclude`
  // (back-compat with worktrees from prior versions, or rare agents
  // that bypass exclude via `git add --force`) baked the lockfile
  // into their commit, and `git merge` lifts it to trunk's index as
  // a new-file ADD. Without this step, the merge commit produced by
  // applyResolution would carry the lockfile into trunk history —
  // visible secret leak (pid/runId/ownerToken). Idempotent: succeeds
  // whether or not the lockfile is actually staged.
  try {
    await execFileAsync(
      'git',
      [
        '-C',
        args.repoPath,
        'reset',
        'HEAD',
        '--',
        '.morion-harness.lock',
      ],
      { timeout: 10_000 },
    );
  } catch {
    // exit 1 = wasn't staged. Fine.
  }
  // Also unlink from disk so the next stage step (or a manual
  // `git add -A` by a power user inspecting trunk) doesn't re-stage.
  try {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(join(args.repoPath, '.morion-harness.lock'));
  } catch {
    // ENOENT is fine.
  }

  // Commit. Git picks up MERGE_HEAD and writes a merge commit
  // with the right parent topology automatically.
  const commitMsg =
    args.commitMessage?.trim() || 'Auto-code: resolve merge conflict';
  try {
    await execFileAsync(
      'git',
      ['-C', args.repoPath, 'commit', '-m', commitMsg],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Morion Auto-code',
          GIT_AUTHOR_EMAIL:
            process.env.GIT_AUTHOR_EMAIL ?? 'auto-code@morion.local',
          GIT_COMMITTER_NAME:
            process.env.GIT_COMMITTER_NAME ?? 'Morion Auto-code',
          GIT_COMMITTER_EMAIL:
            process.env.GIT_COMMITTER_EMAIL ?? 'auto-code@morion.local',
        },
      },
    );
  } catch (err) {
    // Codex finding 2026-05-12: distinguish "commit failed but merge
    // state preserved" from generic git_error. When `git commit`
    // fails (pre-commit hook rejected, etc.), the resolved content
    // is STILL on disk + STILL staged; MERGE_HEAD is STILL set. The
    // user can either:
    //   a) Retry commit (after fixing the hook / unstaging a file /
    //      adjusting config — same applyResolution call works).
    //   b) Abort the whole merge (loses their resolutions).
    // Silently auto-aborting would discard hand edits without
    // asking — that's UX-destructive. Surface the specific error
    // code so the UI can offer a two-button choice.
    let mergeHeadStillSet = false;
    try {
      await execFileAsync(
        'git',
        ['-C', args.repoPath, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'],
        { timeout: 5_000 },
      );
      mergeHeadStillSet = true;
    } catch {
      // exit code 1 = no MERGE_HEAD (commit somehow completed the
      // merge before failing — extremely unlikely). Fall through
      // to generic git_error.
    }
    if (mergeHeadStillSet) {
      return {
        ok: false,
        error: 'commit_failed_merge_still_open',
        message: `git commit failed but the merge state is preserved (MERGE_HEAD still set, resolved files staged). You can Retry commit after fixing the underlying issue, or Abort the merge to discard your resolutions and return trunk to HEAD.\n\nGit said: ${trimErr(err)}`,
        canRetry: true,
      };
    }
    return {
      ok: false,
      error: 'git_error',
      message: `git commit failed: ${trimErr(err)}`,
    };
  }

  // Grab the merge commit SHA + a shortstat for the UI's success
  // banner ("merged 2 files, +19 −5").
  let sha = '';
  try {
    const r = await execFileAsync(
      'git',
      ['-C', args.repoPath, 'rev-parse', 'HEAD'],
      { timeout: 10_000 },
    );
    sha = r.stdout.trim().slice(0, 12);
  } catch {
    sha = '';
  }
  let stat: string | null = null;
  try {
    const r = await execFileAsync(
      'git',
      ['-C', args.repoPath, 'diff', '--shortstat', 'HEAD~1', 'HEAD'],
      { timeout: 10_000 },
    );
    stat = r.stdout.trim() || null;
  } catch {
    stat = null;
  }

  return {
    ok: true,
    sha,
    resolved: written,
    stat,
  };
}

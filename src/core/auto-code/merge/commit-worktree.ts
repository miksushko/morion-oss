/**
 * Auto-commit any uncommitted agent work inside a worktree before the
 * merge can carry it. Extracted from `../merge.ts` so the merge
 * pipeline stays focused on the 8-step orchestrator.
 *
 * Pi / Codex / Claude write files to disk but don't `git commit`
 * automatically — without this step the worktree branch HEAD stays at
 * its parent commit and the merge reports "Already up to date" while
 * the actual code rots as dirty entries in the worktree dir.
 */

import { execFileAsync, trimErr } from './git-ops.js';

export type CommitWorktreeResult =
  | {
      ok: true;
      committed:
        | { sha: string; filesChanged: number; message: string }
        | null;
    }
  | { ok: false; error: 'git_error'; message: string };

export async function commitWorktreeChanges(
  worktreePath: string,
  opts: { message: string },
): Promise<CommitWorktreeResult> {
  // Check working tree state. Untracked files MUST be picked up here
  // (the agent might have created new source files), so we use
  // `git status --porcelain` instead of `git diff --quiet HEAD`.
  let dirty = false;
  try {
    const r = await execFileAsync(
      'git',
      ['-C', worktreePath, 'status', '--porcelain'],
      { timeout: 10_000 },
    );
    dirty = r.stdout.trim().length > 0;
  } catch (e) {
    return {
      ok: false,
      error: 'git_error',
      message: `git status (worktree ${worktreePath}) failed: ${trimErr(e)}`,
    };
  }
  if (!dirty) {
    return { ok: true, committed: null };
  }

  // Stage everything.
  try {
    await execFileAsync('git', ['-C', worktreePath, 'add', '-A'], {
      timeout: 30_000,
    });
  } catch (e) {
    return {
      ok: false,
      error: 'git_error',
      message: `git add -A in worktree failed: ${trimErr(e)}`,
    };
  }

  // Layer 2 defence against the agent-commits-harness-lockfile bug
  // (Echo Drop incident 2026-05-11 — see safety.ts ensureLockfileIgnored).
  // Even with `.git/info/exclude` rule from layer 1, an agent that
  // ran `git add --force` or otherwise bypassed the exclude could
  // have staged `.morion-harness.lock`. Defensively unstage it AND
  // delete the working-tree copy so the resulting commit has no
  // pid/runId/ownerToken leak in user's git history. Idempotent —
  // succeeds whether or not the lockfile was actually staged.
  try {
    await execFileAsync(
      'git',
      ['-C', worktreePath, 'reset', 'HEAD', '--', '.morion-harness.lock'],
      { timeout: 10_000 },
    );
  } catch {
    // exit code 1 is fine — means it wasn't staged.
  }
  // Also unlink from worktree filesystem so a subsequent `git add -A`
  // (e.g. if this auto-commit gets re-run) doesn't re-stage it.
  try {
    const { unlinkSync } = await import('node:fs');
    const lockPath = `${worktreePath}/.morion-harness.lock`;
    unlinkSync(lockPath);
  } catch {
    // ENOENT is fine.
  }

  // Count files that will land in the commit.
  let filesChanged = 0;
  try {
    const r = await execFileAsync(
      'git',
      ['-C', worktreePath, 'diff', '--cached', '--name-only'],
      { timeout: 10_000 },
    );
    filesChanged = r.stdout.trim().split('\n').filter(Boolean).length;
  } catch {
    filesChanged = 0;
  }

  // If `.morion-harness.lock` was the ONLY dirty entry, the reset
  // above emptied the staging area and `git commit` would error
  // with "nothing to commit". Treat as clean no-op: agent produced
  // no real changes; downstream merge step will see the branch
  // unchanged and may report "Already up to date".
  if (filesChanged === 0) {
    return { ok: true, committed: null };
  }

  // Commit. `-q` suppresses chatter so the success path stays quiet.
  try {
    await execFileAsync(
      'git',
      ['-C', worktreePath, 'commit', '-m', opts.message, '-q'],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          // Force a known author when the user hasn't configured git
          // globally — otherwise `git commit` errors with "Please
          // tell me who you are". User can amend afterwards.
          GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Morion Auto-code',
          GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'auto-code@morion.local',
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Morion Auto-code',
          GIT_COMMITTER_EMAIL:
            process.env.GIT_COMMITTER_EMAIL ?? 'auto-code@morion.local',
        },
      },
    );
  } catch (e) {
    return {
      ok: false,
      error: 'git_error',
      message: `git commit in worktree failed: ${trimErr(e)}`,
    };
  }

  // Grab the SHA.
  let sha = '';
  try {
    const r = await execFileAsync(
      'git',
      ['-C', worktreePath, 'rev-parse', 'HEAD'],
      { timeout: 10_000 },
    );
    sha = r.stdout.trim();
  } catch {
    sha = '';
  }

  return {
    ok: true,
    committed: {
      sha: sha.slice(0, 12),
      filesChanged,
      message: opts.message,
    },
  };
}

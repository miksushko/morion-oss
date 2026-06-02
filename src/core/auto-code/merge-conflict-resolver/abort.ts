import { execFileAsync, trimErr } from './internal.js';
import { readMergeConflictState } from './read-state.js';

/** Idempotent `git merge --abort`. Returns ok=true with a flag
 *  noting whether anything was actually aborted. */
export async function abortMerge(
  repoPath: string,
): Promise<
  | { ok: true; aborted: boolean }
  | { ok: false; error: 'repo_not_found' | 'git_error'; message: string }
> {
  // No-op when no merge in progress.
  const state = await readMergeConflictState(repoPath);
  if (!state.ok) return state;
  if (!state.inProgress) return { ok: true, aborted: false };
  try {
    await execFileAsync('git', ['-C', repoPath, 'merge', '--abort'], {
      timeout: 10_000,
    });
    return { ok: true, aborted: true };
  } catch (err) {
    return {
      ok: false,
      error: 'git_error',
      message: `git merge --abort failed: ${trimErr(err)}`,
    };
  }
}

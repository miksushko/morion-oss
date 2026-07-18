/**
 * Per-repo git-admin mutex for worktree operations.
 *
 * Bug (2026-07-14): dragging N tickets into `todo` at once fires N
 * concurrent `enqueueTicket` HTTP requests; each claims its
 * `workflow_runs` row synchronously and then hits `git worktree add`
 * on the SAME linked repo at the same instant. Concurrent
 * `worktree add` invocations contend on the shared `.git` admin area
 * (`config.lock` / `HEAD.lock` / `packed-refs` / `index.lock`) — a
 * loser exits non-zero, the run is marked `worktree_setup_failed`, and
 * the fail→backlog→re-enqueue cascade then trips the admission
 * re-check into mislabeling sibling runs as `cancelled`. The tickets
 * "silently fail before the agent runs".
 *
 * The merge path already serialises per repo via `createRepoMergeLock`
 * (`repo-merge-lock.ts`). Worktree creation had no equivalent. This is
 * that missing lock — a process-wide singleton (module-level) so the
 * per-request orchestrators all queue through the same chain, keyed by
 * repo path. `worktree add` and `worktree remove` both mutate the
 * admin area, so both go through it.
 *
 * Same promise-chain shape as the merge lock: each caller appends to
 * the per-repo chain, runs after the prior settles (regardless of its
 * outcome), and releases when it's still the tail.
 */

const chain = new Map<string, Promise<unknown>>();

export function withRepoGitLock<T>(
  repoPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chain.get(repoPath) ?? Promise.resolve();
  const next = prev.then(
    () => fn(),
    () => fn(),
  );
  chain.set(repoPath, next);
  return (async () => {
    try {
      return await next;
    } finally {
      if (chain.get(repoPath) === next) {
        chain.delete(repoPath);
      }
    }
  })();
}

/** Test-only: clear the chain between cases so a rejected fn from one
 *  test can't leave a poisoned tail for the next. */
export function _resetRepoGitLock(): void {
  chain.clear();
}

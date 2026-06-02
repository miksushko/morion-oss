/**
 * Per-repo merge mutex. Serialises ALL merge-related git ops on the
 * same repo so React StrictMode's double-effect-fire (and any other
 * concurrent caller) can't race two `git merge --no-ff` invocations
 * against the same trunk.
 *
 * Real incident 2026-05-12: StrictMode fired merge-conflict-prepare
 * twice in parallel → two concurrent mergeWorktreeIntoTarget → one
 * set MERGE_HEAD + staged files, the other's entry-time
 * stale-MERGE_HEAD guard aborted mid-flow → trunk left with
 * `M game.js` (staged, no MERGE_HEAD), every subsequent merge attempt
 * refused with "working tree dirty".
 *
 * Implementation: per-repoPath promise chain. Each caller appends to
 * the chain; runs only after prior completes; clears when no further
 * callers queued.
 */
export type RepoMergeLock = <T>(
  repoPath: string,
  fn: () => Promise<T>,
) => Promise<T>;

export function createRepoMergeLock(): RepoMergeLock {
  const chain = new Map<string, Promise<unknown>>();
  return async <T>(repoPath: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chain.get(repoPath) ?? Promise.resolve();
    // Run fn AFTER prev settles regardless of prev's outcome (we
    // don't want a prior failure to cascade-reject our turn).
    const next = prev.then(
      () => fn(),
      () => fn(),
    );
    chain.set(repoPath, next);
    try {
      return await next;
    } finally {
      // Only release if we're still the tail — a later caller may
      // have already chained on top.
      if (chain.get(repoPath) === next) {
        chain.delete(repoPath);
      }
    }
  };
}

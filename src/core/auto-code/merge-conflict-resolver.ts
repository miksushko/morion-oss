/**
 * Manual merge conflict resolver — backend support for the
 * ConflictResolverModal UI shipped 2026-05-11.
 *
 * The flow:
 *
 *   1. `mergeWorktreeIntoTarget({abortOnConflict: false})` is run
 *      by the merge route on the trunk checkout. When it produces
 *      a conflict, MERGE_HEAD + UU files are LEFT IN PLACE (the
 *      abort step is skipped on this flag) so we can inspect them.
 *
 *   2. `readMergeConflictState(repoPath)` enumerates the UU files
 *      and reads three views per file:
 *        - `ours` (HEAD / target branch's content, pre-merge)
 *        - `theirs` (incoming / worktree branch's content)
 *        - `merged` (current working-tree content with conflict
 *           markers `<<<<<<< / ======= / >>>>>>>` — what git
 *           wrote when it tried to auto-merge)
 *
 *   3. The UI lets the user edit the `merged` view OR pick
 *      sides per conflict region OR call AI auto-resolve.
 *
 *   4. `applyResolution(repoPath, files)` writes each file's
 *      resolved content to the worktree, runs `git add` on it,
 *      then `git commit` to finish the merge. The merge commit
 *      is created via plain `git commit` since `git merge` already
 *      set up MERGE_HEAD — git uses that to mark the commit as a
 *      merge with two parents automatically.
 *
 *   5. `abortMerge(repoPath)` runs `git merge --abort` for the
 *      cancel path; idempotent on a no-merge state.
 *
 * Safety invariants:
 *
 *   - File content is read/written via `node:fs` not `execFile`
 *     to avoid shell-escape headaches with binary content.
 *   - `ours`/`theirs` content is read via `git show :1:<path>` /
 *     `git show :2:<path>` / `git show :3:<path>` — the index
 *     stages git populates during a conflict:
 *       :1 = base (merge-base)
 *       :2 = ours (HEAD)
 *       :3 = theirs (incoming)
 *     This works even if the worktree file content was edited by
 *     the user (since we read from the index, not the working tree).
 *   - Resolved files must contain no leftover `<<<<<<<` / `=======`
 *     / `>>>>>>>` markers — defence-in-depth check; the UI is
 *     supposed to validate too.
 *   - Binary conflicts surface with `binary: true` and empty
 *     ours/theirs content. The UI can't render them inline; it
 *     should ask the user to pick a side via a separate path.
 *
 * Implementation split across `merge-conflict-resolver/` sibling
 * modules; this file is a barrel re-export so every caller (route
 * dynamic imports, ConflictResolverModal data shapes, orchestrator
 * auto-merge hook) keeps the same import path.
 */

export {
  CONFLICT_MARKER_RE,
  FILE_CONTENT_BYTE_CAP,
} from './merge-conflict-resolver/types.js';
export type {
  ApplyResolutionArgs,
  ApplyResolutionResult,
  ConflictFileEntry,
  MergeConflictStateResult,
} from './merge-conflict-resolver/types.js';
export { readMergeConflictState } from './merge-conflict-resolver/read-state.js';
export { applyResolution } from './merge-conflict-resolver/apply.js';
export { detectActiveCommitHooks } from './merge-conflict-resolver/hooks.js';
export { abortMerge } from './merge-conflict-resolver/abort.js';

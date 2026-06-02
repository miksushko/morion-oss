/** Regex used to detect leftover conflict markers in the resolved
 *  file contents — `<<<<<<<` / `=======` / `>>>>>>>`. Anchored at
 *  line start (multiline mode) so a `=======` literal that appears
 *  inside a string-literal in code doesn't false-positive (it'd need
 *  to be the entire line). */
export const CONFLICT_MARKER_RE = /^<<<<<<<\s|^=======$|^>>>>>>>\s/m;

/** Hard cap on per-file content bytes the resolver reads in or
 *  writes out. Anything larger surfaces as a "too large" hint to the
 *  UI which then refuses inline editing. */
export const FILE_CONTENT_BYTE_CAP = 200 * 1024;

export interface ConflictFileEntry {
  /** Path relative to repo root, slash-separated. */
  readonly path: string;
  /** Whether git classified this conflict as binary (`-z` shows
   *  null-content blobs). Binary conflicts can't be merged textually
   *  — UI must surface a separate path (pick ours / pick theirs). */
  readonly binary: boolean;
  /** HEAD-side content (target branch's view) at conflict time.
   *  Null when too large to load (> 200KB). */
  readonly ours: string | null;
  /** Incoming-side content (worktree branch's view). Null when too
   *  large to load. */
  readonly theirs: string | null;
  /** Current working-tree content with git's conflict markers. */
  readonly merged: string;
  /** Byte sizes of the ours/theirs sides (when known). Used for the
   *  "too large" UI fallback. */
  readonly oursSize: number | null;
  readonly theirsSize: number | null;
}

export type MergeConflictStateResult =
  | {
      readonly ok: true;
      readonly inProgress: true;
      readonly mergeHeadRef: string;
      readonly headRef: string;
      readonly files: readonly ConflictFileEntry[];
    }
  | {
      readonly ok: true;
      readonly inProgress: false;
    }
  | {
      readonly ok: false;
      readonly error: 'repo_not_found' | 'git_error';
      readonly message: string;
    };

export interface ApplyResolutionArgs {
  repoPath: string;
  /** Map path → resolved file content. Each file must be free of
   *  conflict markers. */
  resolvedFiles: Readonly<Record<string, string>>;
  /** Commit message. Default: `Auto-code: resolve merge conflict`. */
  commitMessage?: string;
}

export type ApplyResolutionResult =
  | {
      readonly ok: true;
      readonly sha: string;
      readonly resolved: readonly string[];
      readonly stat: string | null;
    }
  | {
      readonly ok: false;
      readonly error:
        | 'repo_not_found'
        | 'no_merge_in_progress'
        | 'leftover_markers'
        | 'invalid_path'
        | 'binary_conflict'
        | 'commit_failed_merge_still_open'
        | 'git_error';
      readonly message: string;
      /** Set when error=leftover_markers / invalid_path / binary_conflict —
       *  paths the caller submitted that were rejected, so the UI can
       *  highlight them. */
      readonly violatingPaths?: readonly string[];
      /** Set when error=commit_failed_merge_still_open — the resolved
       *  content is still on disk + staged, MERGE_HEAD still set. The
       *  UI offers Retry (re-POST apply) vs Abort (POST merge-abort,
       *  losing resolutions). */
      readonly canRetry?: boolean;
    };

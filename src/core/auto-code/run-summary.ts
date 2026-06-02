import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { findWorktreePath, worktreeBranchName } from './worktree-paths.js';

const execFileAsync = promisify(execFile);

/**
 * Compute a plain-English diff summary for an auto-code run's
 * worktree branch. Used by the AutoCodeDrawer's "What Mo did"
 * section to give the user a one-line "N files / +X / −Y" overview
 * without dropping to a terminal.
 *
 * Sister of `mergeWorktreeIntoTarget` in `merge.ts` — same branch
 * probing (handles both legacy `worktree-auto-XXX` and new
 * `auto-XXX` naming) + same target-branch auto-detect. Pure read —
 * never mutates anything on disk or in git.
 *
 * Returns null fields when:
 *   - The worktree branch can't be located (already reaped, rename
 *     race, etc.) → `{ ok: false, error: 'branch_missing' }`.
 *   - The repo path isn't a git repo at all → `{ ok: false,
 *     error: 'repo_not_found' }`.
 *   - Detection or `git diff` itself errored → caller may treat
 *     as "no summary available" without aborting drawer render.
 *
 * On success, `shortStat` is the raw git output ("2 files changed,
 * 19 insertions(+), 5 deletions(-)") and `files` / `additions` /
 * `deletions` are parsed numbers (additions / deletions may be 0
 * when the run only added or only deleted, not both — git omits
 * the missing side in shortstat output). When the diff is empty
 * (worktree branch == target), all three numbers are 0 and
 * `shortStat` is null.
 */

const DEFAULT_TARGET_CANDIDATES = ['main', 'master'] as const;

export interface DiffStatOk {
  readonly ok: true;
  readonly targetBranch: string;
  readonly branchName: string;
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
  /** Raw `git diff --shortstat` output. Null when there's no diff
   *  (e.g. branch hasn't diverged from target yet). */
  readonly shortStat: string | null;
}

export interface DiffStatErr {
  readonly ok: false;
  readonly error:
    | 'repo_not_found'
    | 'branch_missing'
    | 'target_missing'
    | 'git_error';
  readonly message: string;
}

export type DiffStatResult = DiffStatOk | DiffStatErr;

export interface DiffStatArgs {
  repoPath: string;
  worktreeName: string;
  /** Override the target branch the diff is computed against.
   *  Default = auto-detect main/master. */
  targetBranch?: string;
}

export async function computeRunDiffStat(args: DiffStatArgs): Promise<DiffStatResult> {
  // Probe both branch-naming conventions (legacy `worktree-*` prefix
  // from claude-launcher + new bare worktree name from the workflow
  // runner). Same dance as `mergeWorktreeIntoTarget`.
  const candidates = [args.worktreeName, worktreeBranchName(args.worktreeName)];
  let branchName: string | null = null;
  for (const c of candidates) {
    const r = await branchExists(args.repoPath, c);
    if (!r.ok) return r;
    if (r.exists) {
      branchName = c;
      break;
    }
  }
  if (!branchName) {
    return {
      ok: false,
      error: 'branch_missing',
      message: `Neither "${candidates[0]}" nor "${candidates[1]}" exists in ${args.repoPath}.`,
    };
  }

  let targetBranch: string;
  if (args.targetBranch) {
    const r = await branchExists(args.repoPath, args.targetBranch);
    if (!r.ok) return r;
    if (!r.exists) {
      return {
        ok: false,
        error: 'target_missing',
        message: `Target branch "${args.targetBranch}" not found.`,
      };
    }
    targetBranch = args.targetBranch;
  } else {
    let detected: string | null = null;
    for (const c of DEFAULT_TARGET_CANDIDATES) {
      const r = await branchExists(args.repoPath, c);
      if (r.ok && r.exists) {
        detected = c;
        break;
      }
    }
    if (!detected) {
      return {
        ok: false,
        error: 'target_missing',
        message: 'Neither "main" nor "master" found; pass explicit targetBranch.',
      };
    }
    targetBranch = detected;
  }

  // Triple-dot diff: changes from merge-base to branch tip — i.e.
  // what the auto-code branch ADDED on top of the target, ignoring
  // anything the target added in parallel since branch creation.
  // This is the right number for "what did Mo change?".
  let raw = '';
  try {
    const out = await execFileAsync(
      'git',
      ['-C', args.repoPath, 'diff', '--shortstat', `${targetBranch}...${branchName}`],
      { timeout: 30_000 },
    );
    raw = out.stdout.trim();
  } catch (err) {
    return {
      ok: false,
      error: 'git_error',
      message: `git diff --shortstat failed: ${trimErr(err)}`,
    };
  }

  if (raw.length === 0) {
    return {
      ok: true,
      targetBranch,
      branchName,
      files: 0,
      additions: 0,
      deletions: 0,
      shortStat: null,
    };
  }

  // Parse: "N files changed, X insertions(+), Y deletions(-)".
  // Singular variants happen ("1 file changed, 1 insertion(+)") and
  // each side (ins / del) is optional. Use independent regexes per
  // field so missing parts don't kill the whole parse.
  const filesMatch = /(\d+)\s+files?\s+changed/.exec(raw);
  const insMatch = /(\d+)\s+insertions?\(\+\)/.exec(raw);
  const delMatch = /(\d+)\s+deletions?\(-\)/.exec(raw);

  return {
    ok: true,
    targetBranch,
    branchName,
    files: filesMatch ? Number(filesMatch[1]) : 0,
    additions: insMatch ? Number(insMatch[1]) : 0,
    deletions: delMatch ? Number(delMatch[1]) : 0,
    shortStat: raw,
  };
}

/** Probe whether the worktree directory still exists on disk —
 *  for callers that want to gate "files changed" affordances on a
 *  walkable worktree vs the post-merge state where it may already
 *  be reaped. */
export function worktreeExistsOnDisk(repoPath: string, worktreeName: string): boolean {
  return findWorktreePath(repoPath, worktreeName) !== null;
}

async function branchExists(
  repoPath: string,
  branch: string,
): Promise<
  | { ok: true; exists: boolean }
  | { ok: false; error: 'repo_not_found' | 'git_error'; message: string }
> {
  try {
    await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', '--verify', '--quiet', branch],
      { timeout: 10_000 },
    );
    return { ok: true, exists: true };
  } catch (err) {
    const e = err as { code?: number; stderr?: string; message?: string };
    const stderr = (e.stderr ?? '').trim();
    if (/not a git repository/i.test(stderr)) {
      return {
        ok: false,
        error: 'repo_not_found',
        message: `Repo "${repoPath}" is not a git repository.`,
      };
    }
    if (e.code === 1 && stderr.length === 0) {
      return { ok: true, exists: false };
    }
    return {
      ok: false,
      error: 'git_error',
      message: `git rev-parse failed: ${trimErr(err)}`,
    };
  }
}

function trimErr(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; message?: string };
    if (typeof e.stderr === 'string' && e.stderr.length > 0) return e.stderr.trim();
    if (typeof e.message === 'string') return e.message.trim();
  }
  return String(err);
}

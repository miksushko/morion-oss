/**
 * Low-level git wrappers used by the auto-code merge helper. Extracted
 * from `../merge.ts` so the orchestrator stays focused on the merge
 * pipeline. Every function shells `git -C <repoPath> …` via
 * `execFile`; nothing else.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_TARGET_CANDIDATES = ['main', 'master'] as const;

export type BranchExistsResult =
  | { ok: true; exists: boolean }
  | {
      ok: false;
      error: 'repo_not_found' | 'git_error';
      message: string;
    };

export async function branchExists(
  repoPath: string,
  branch: string,
): Promise<BranchExistsResult> {
  try {
    await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', '--verify', '--quiet', branch],
      { timeout: 10_000 },
    );
    return { ok: true, exists: true };
  } catch (e) {
    const errObj = e as { code?: number; stderr?: string; message?: string };
    const stderr = (errObj.stderr ?? '').trim();
    if (/not a git repository/i.test(stderr)) {
      return {
        ok: false,
        error: 'repo_not_found',
        message: `Repo path "${repoPath}" is not a git repository.`,
      };
    }
    // `git rev-parse --verify --quiet <ref>` exits with code 1 when
    // the ref doesn't exist AND prints nothing to stderr. That's the
    // canonical "branch missing" signal — not a tool failure. Any
    // other exit code (128 = bad cwd / no .git / git invocation
    // failed) IS a real error.
    if (errObj.code === 1 && stderr.length === 0) {
      return { ok: true, exists: false };
    }
    return {
      ok: false,
      error: 'git_error',
      message: `git rev-parse failed: ${trimErr(e)}`,
    };
  }
}

export async function detectMainBranch(
  repoPath: string,
): Promise<string | null> {
  for (const candidate of DEFAULT_TARGET_CANDIDATES) {
    const r = await branchExists(repoPath, candidate);
    if (r.ok && r.exists) return candidate;
  }
  return null;
}

export async function isWorkingTreeDirty(
  repoPath: string,
): Promise<{ ok: true; dirty: boolean } | { ok: false }> {
  // `git diff --quiet HEAD` exits 0 when there are NO tracked
  // changes (staged or unstaged) and non-zero otherwise. Untracked
  // files don't block `git merge` (git proceeds and warns only on
  // overwrite collisions), so we deliberately skip them here —
  // earlier `git status --porcelain` check refused legitimate merges
  // because of unrelated untracked entries like `.claude/` /
  // `node_modules/` / scratch files.
  try {
    await execFileAsync(
      'git',
      ['-C', repoPath, 'diff', '--quiet', 'HEAD'],
      { timeout: 10_000 },
    );
    return { ok: true, dirty: false };
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 1) return { ok: true, dirty: true };
    // Other exit codes (128 = no HEAD on a brand-new repo, etc.) →
    // treat as "can't tell". Caller may want to soft-fail but for
    // now we conservatively report not-dirty so merge can attempt.
    return { ok: true, dirty: false };
  }
}

/** Best-effort abort of any in-progress merge. Idempotent: no-op
 *  when MERGE_HEAD doesn't exist. */
export async function abortStaleMerge(repoPath: string): Promise<void> {
  try {
    await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'],
      { timeout: 5_000 },
    );
  } catch {
    // MERGE_HEAD doesn't exist (clean state) — nothing to abort.
    return;
  }
  try {
    await execFileAsync(
      'git',
      ['-C', repoPath, 'merge', '--abort'],
      { timeout: 10_000 },
    );
  } catch {
    // Best-effort. If abort itself fails, the working-tree-dirty
    // check downstream surfaces a clear error to the caller.
  }
}

export function trimErr(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; message?: string; code?: number };
    if (typeof e.stderr === 'string' && e.stderr.length > 0) {
      return e.stderr.trim();
    }
    if (typeof e.message === 'string') return e.message.trim();
  }
  return String(err);
}

export { execFileAsync };

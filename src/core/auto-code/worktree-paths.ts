import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

const execFile = promisify(execFileCb);

/**
 * Auto-code worktree path helpers.
 *
 * Extracted from `claude-launcher.ts` (L1.T9 precursor) so the deprecated
 * launcher's spawn functions can be removed independently once the harness
 * migration lands — the worktree helpers are agent-agnostic and consumed
 * by toggle-killer, run-summary, merge, run-files, codex-launcher,
 * workflow-orchestrator, etc.
 */

/** Subdirectory under the linked repo where auto-code stores its
 *  per-run git worktrees. Originally `.claude/` (when only Claude
 *  Code was the auto-code engine — the path leaked the engine's
 *  brand into every repo). Renamed to `.morion/` (2026-05-11) once
 *  Pi / Codex / Opencode were also supported through the harness;
 *  the directory now correctly reflects the orchestrator's name,
 *  not whichever specific agent happens to run inside.
 *
 *  Backwards compat: existing worktrees under `<repo>/.claude/worktrees/`
 *  are still discoverable via `LEGACY_WORKTREE_DIR_NAMES` (the orphan
 *  sweep + remove helpers walk both paths). Old workflow_runs rows
 *  keep their stored absolute path verbatim and reach the right
 *  worktree without migration. */
export const WORKTREE_DIR_NAME = '.morion';
export const LEGACY_WORKTREE_DIR_NAMES: readonly string[] = ['.claude'];

/** Absolute path the harness's per-run worktree lives under. */
export function worktreePath(repoPath: string, worktreeName: string): string {
  return join(repoPath, WORKTREE_DIR_NAME, 'worktrees', worktreeName);
}

/** Legacy lookup — used by `removeWorktree` + orphan sweep so pre-
 *  rename worktrees still get reaped. Returns the first candidate
 *  path that actually exists on disk; returns null when neither
 *  the new nor any legacy path is materialized. */
export function findWorktreePath(
  repoPath: string,
  worktreeName: string,
): string | null {
  const candidates = [
    worktreePath(repoPath, worktreeName),
    ...LEGACY_WORKTREE_DIR_NAMES.map((dir) =>
      join(repoPath, dir, 'worktrees', worktreeName),
    ),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/** Branch name Claude assigns to a `--worktree <name>` invocation
 *  (spike-confirmed: prefix `worktree-`). */
export function worktreeBranchName(worktreeName: string): string {
  return `worktree-${worktreeName}`;
}

/**
 * Idempotent worktree teardown. Both git commands are tolerant of a
 * missing target — if the worktree was already removed (or never
 * existed), we still walk through and report success so cleanup loops
 * can sweep blindly.
 *
 * Failure to remove a branch when the worktree is gone is non-fatal
 * (orphaned branches are recoverable with `git branch -D`). Failure
 * to remove the worktree itself when it exists IS surfaced — that's
 * the only case the orchestrator needs to retry / log.
 */
export async function removeWorktree(
  repoPath: string,
  worktreeName: string,
): Promise<{ worktreeRemoved: boolean; branchRemoved: boolean; error: string | null }> {
  // Look up the actual on-disk location — new worktrees live under
  // `.morion/worktrees/`, pre-rename ones under `.claude/worktrees/`.
  // `findWorktreePath` returns null when neither candidate exists.
  const wtPath = findWorktreePath(repoPath, worktreeName);
  let worktreeRemoved = false;
  let branchRemoved = false;
  let error: string | null = null;
  if (wtPath) {
    try {
      await execFile('git', ['-C', repoPath, 'worktree', 'remove', '--force', wtPath], {
        timeout: 30_000,
      });
      worktreeRemoved = true;
    } catch (e) {
      error = (e as Error).message ?? String(e);
    }
  }
  // Best-effort branch cleanup. `-D` is force-delete (ignores
  // unmerged warnings); failures here just leave the branch behind.
  try {
    await execFile('git', ['-C', repoPath, 'branch', '-D', worktreeBranchName(worktreeName)], {
      timeout: 30_000,
    });
    branchRemoved = true;
  } catch {
    // Branch missing or refused — orphan branches are harmless and
    // recoverable; surface only worktree-removal failures.
  }
  return { worktreeRemoved, branchRemoved, error };
}

/**
 * Walk `git worktree list --porcelain` for a repo and return any
 * worktrees under the harness's worktree directory (new `.morion/`
 * AND legacy `.claude/`) whose leaf `auto-*` name is NOT in the
 * caller-provided `activeNames` set.
 *
 * Called on app start by the orchestrator (#6) to sweep crash
 * fallout: queue rows that died mid-run leave dangling worktrees,
 * and a fresh start should reclaim them. The orchestrator pulls
 * active rows from the queue, derives names, and passes them in.
 *
 * Both new + legacy prefixes get scanned (2026-05-11 rename) so
 * pre-rename worktrees still get reaped — without that, every
 * pre-rename auto-* worktree would silently survive every cleanup
 * pass forever.
 */
export async function listOrphanWorktrees(
  repoPath: string,
  activeNames: ReadonlySet<string>,
): Promise<string[]> {
  let porcelain: string;
  try {
    const r = await execFile('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
      timeout: 30_000,
    });
    porcelain = r.stdout;
  } catch {
    return [];
  }
  const orphans: string[] = [];
  // Porcelain format: each entry is "worktree <abspath>\nHEAD ...\nbranch ...\n\n"
  // Lines that start with "worktree " carry the absolute path. Git
  // resolves the path through realpath (so a symlinked tmpdir like
  // /var/folders → /private/var/folders comes back symlink-resolved).
  // Mirror that on our side or the prefix match silently misses every
  // worktree on macOS tmpdirs.
  let resolvedRepo: string;
  try {
    resolvedRepo = realpathSync(repoPath);
  } catch {
    resolvedRepo = repoPath;
  }
  const prefixes = [WORKTREE_DIR_NAME, ...LEGACY_WORKTREE_DIR_NAMES].map(
    (dir) => join(resolvedRepo, dir, 'worktrees') + '/',
  );
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const path = line.slice('worktree '.length).trim();
    let matched: string | null = null;
    for (const p of prefixes) {
      if (path.startsWith(p)) {
        matched = path.slice(p.length);
        break;
      }
    }
    if (!matched) continue;
    if (!matched.startsWith('auto-')) continue;
    if (!activeNames.has(matched)) orphans.push(matched);
  }
  return orphans;
}

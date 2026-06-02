import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Trunk-guard — detect + auto-revert agent leakage into the linked
 * repo's main checkout.
 *
 * Background: auto-code is supposed to operate ENTIRELY inside the
 * per-run worktree at `<repo>/.morion/worktrees/auto-<runId>/`. The
 * trunk checkout (the repo root itself, with `main`/`master` checked
 * out) should never receive writes from the agent. In practice:
 *
 *   - Legacy `claude-launcher.spawnClaudeFix` spawns claude with
 *     `cwd = repoPath` (trunk) and relies on the `--worktree <name>`
 *     flag to make claude cd into the worktree before doing any tool
 *     op. When that flag is silently ignored — e.g. claude version
 *     mismatch, Bash-tool call that escapes the worktree, sidecar
 *     killed mid-run leaving a zombie child — writes land in trunk.
 *
 *   - New harness path (`runner.dispatchDag` → adapter spawn) sets
 *     `cwd = worktreePath` directly, much safer. But a Bash tool
 *     call inside the agent that does `cd ../../..` could still
 *     escape, and tool-result file-write paths can be absolute.
 *
 * Real incident 2026-05-11: user ran an auto-code ticket, agent
 * committed correctly inside the worktree, but 45 lines of mystery
 * code also showed up in trunk's working tree — uncommitted, not in
 * any branch. Next merge attempt failed with "Main repo working
 * tree has uncommitted changes". User had to manually `git stash`
 * to unblock. The 45 lines came from an earlier run that leaked.
 *
 * Trunk-guard wraps every workflow run:
 *
 *   1. **Before**: `snapshotTrunkState(repoPath)` captures HEAD ref
 *      + a content hash for every tracked file in the working tree.
 *      User-already-modified files are PRESERVED — we record their
 *      current hash, not HEAD's, so we don't blame the user later.
 *
 *   2. **After** (regardless of run terminal state): `auditTrunk
 *      AfterRun(repoPath, baseline)` walks the same set, compares
 *      hashes. Any file whose hash differs from baseline AND whose
 *      baseline hash matched HEAD (i.e. file was clean at baseline)
 *      is flagged as "leaked".
 *
 *   3. **Revert**: `revertLeakedFiles(repoPath, paths)` runs
 *      `git checkout HEAD -- <path>` for each leaked file. The
 *      content goes back to HEAD; user's pre-existing dirty edits
 *      stay untouched (different code path — those paths weren't
 *      in the leaked set).
 *
 * What it does NOT touch:
 *   - Untracked files (e.g. `node_modules/`, `.morion/`, `.claude/`,
 *     scratch files the user left around). The agent's worktree
 *     lives under `.morion/worktrees/` and is properly untracked
 *     anyway.
 *   - Files the user manually modified BEFORE the run started —
 *     baseline records their dirty hash, audit sees the same hash
 *     → no diff → no revert.
 *   - HEAD ref. If a merge happened mid-run somehow (impossible
 *     under normal orchestrator paths, but defensive), the audit
 *     bails with `headChanged: true` and reverts nothing.
 *
 * Risk: if the user MANUALLY edits a clean file DURING the run, the
 * audit will revert that edit. Documented tradeoff — the user
 * shouldn't be hand-editing trunk while auto-code runs, and the
 * activity-feed leak comment makes the revert visible. Future work
 * could disable trunk-guard via a per-folder setting if a user wants
 * the freedom.
 */

export interface TrunkSnapshot {
  /** Repo root (absolute path). Same as the run's `repoPath`. */
  readonly repoPath: string;
  /** `git rev-parse HEAD` at snapshot time. The audit refuses to
   *  proceed if HEAD moved mid-run (caller decides what to do — usually
   *  log and skip the revert). */
  readonly headRef: string;
  /** Map of tracked-file path → working-tree blob hash at snapshot
   *  time. Built from `git ls-files -s` + `git hash-object` on each
   *  dirty file. */
  readonly fileHashes: ReadonlyMap<string, string>;
  /** Subset of `fileHashes` whose hash differs from HEAD. These are
   *  user-owned dirty files we MUST NOT touch in the audit/revert. */
  readonly userDirtyFiles: ReadonlySet<string>;
  /** Timestamp of snapshot (ms epoch) — for telemetry. */
  readonly takenAt: number;
}

export interface TrunkAuditOk {
  readonly ok: true;
  readonly snapshot: TrunkSnapshot;
  /** Files that became dirty DURING the run AND were clean at
   *  snapshot time. These are the leakage candidates. Empty array
   *  = clean exit, no revert needed. */
  readonly leakedFiles: readonly string[];
  /** Whether HEAD moved between snapshot and audit. Should be false
   *  under normal orchestrator paths — surface so the caller can
   *  warn. */
  readonly headChanged: boolean;
}

export interface TrunkAuditErr {
  readonly ok: false;
  readonly error: 'repo_not_found' | 'git_error';
  readonly message: string;
}

export type TrunkAuditResult = TrunkAuditOk | TrunkAuditErr;

/** Snapshot the trunk's working tree state. Tolerates a non-git
 *  path by returning ok=false; the caller decides whether to abort
 *  the run or proceed without guard. */
export async function snapshotTrunkState(
  repoPath: string,
): Promise<
  | { ok: true; snapshot: TrunkSnapshot }
  | { ok: false; error: 'repo_not_found' | 'git_error'; message: string }
> {
  let headRef = '';
  try {
    const r = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', 'HEAD'],
      { timeout: 10_000 },
    );
    headRef = r.stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string };
    if (/not a git repository/i.test(e.stderr ?? '')) {
      return {
        ok: false,
        error: 'repo_not_found',
        message: `"${repoPath}" is not a git repository.`,
      };
    }
    return {
      ok: false,
      error: 'git_error',
      message: `git rev-parse HEAD failed: ${trimErr(err)}`,
    };
  }

  // List every tracked file with its HEAD blob hash (index blob =
  // HEAD blob when working tree is otherwise clean). We also need
  // the WORKING-TREE blob to know if the file is user-dirty.
  const tracked = await readTrackedFileHashes(repoPath);
  if (!tracked.ok) return tracked;

  const userDirty = new Set<string>();
  for (const [path, info] of tracked.entries) {
    if (info.workingHash !== info.headHash) userDirty.add(path);
  }

  const fileHashes = new Map<string, string>();
  for (const [path, info] of tracked.entries) {
    fileHashes.set(path, info.workingHash);
  }

  return {
    ok: true,
    snapshot: {
      repoPath,
      headRef,
      fileHashes,
      userDirtyFiles: userDirty,
      takenAt: Date.now(),
    },
  };
}

/** Compare the current trunk state to `baseline` snapshot. Returns a
 *  list of files that became dirty after the snapshot AND were clean
 *  at snapshot time (i.e. matched HEAD). Those are the leakage
 *  candidates. */
export async function auditTrunkAfterRun(
  baseline: TrunkSnapshot,
): Promise<TrunkAuditResult> {
  // Re-read HEAD; bail if it moved.
  let currentHead = '';
  try {
    const r = await execFileAsync(
      'git',
      ['-C', baseline.repoPath, 'rev-parse', 'HEAD'],
      { timeout: 10_000 },
    );
    currentHead = r.stdout.trim();
  } catch (err) {
    return {
      ok: false,
      error: 'git_error',
      message: `git rev-parse HEAD (post-run) failed: ${trimErr(err)}`,
    };
  }
  const headChanged = currentHead !== baseline.headRef;

  // Re-read tracked file state.
  const tracked = await readTrackedFileHashes(baseline.repoPath);
  if (!tracked.ok) return tracked;

  const leaked: string[] = [];
  for (const [path, info] of tracked.entries) {
    // User-dirty at baseline → user's edit, never blame.
    if (baseline.userDirtyFiles.has(path)) continue;
    // Was the file present at baseline?
    const baselineHash = baseline.fileHashes.get(path);
    if (baselineHash === undefined) {
      // New tracked file post-snapshot — could be an agent leak via
      // `git add <new-file>` against trunk. Treat as leaked.
      leaked.push(path);
      continue;
    }
    // File was clean at baseline (baselineHash === HEAD's headHash).
    // If working hash differs now from baseline, agent dirtied it.
    if (info.workingHash !== baselineHash) {
      leaked.push(path);
    }
  }
  // We deliberately don't loop over `baseline.fileHashes` to detect
  // DELETED files — `git checkout HEAD -- <path>` restores deletions
  // too, so we let the same path through with a workingHash of
  // empty-string ↔ baseline-non-empty. Actually `readTrackedFileHashes`
  // only lists files currently in the index/working tree; a deleted
  // file wouldn't appear in `tracked.entries`. Handle deletion case
  // separately:
  for (const [path, baselineHash] of baseline.fileHashes) {
    if (baseline.userDirtyFiles.has(path)) continue;
    if (!tracked.entries.has(path)) {
      // File present at baseline (clean), missing now. Agent deleted
      // a trunk file — definite leak.
      void baselineHash;
      leaked.push(path);
    }
  }

  return {
    ok: true,
    snapshot: baseline,
    leakedFiles: leaked,
    headChanged,
  };
}

/** Revert a list of leaked files to their HEAD content. Safe to call
 *  with an empty list — no-op. Each revert is `git checkout HEAD --
 *  <path>` which handles modify/delete/restore uniformly. Returns a
 *  per-file report so the caller can log partial successes. */
export async function revertLeakedFiles(
  repoPath: string,
  paths: readonly string[],
): Promise<{
  reverted: readonly string[];
  failed: readonly { path: string; message: string }[];
}> {
  const reverted: string[] = [];
  const failed: { path: string; message: string }[] = [];
  for (const p of paths) {
    try {
      await execFileAsync(
        'git',
        ['-C', repoPath, 'checkout', 'HEAD', '--', p],
        { timeout: 30_000 },
      );
      reverted.push(p);
    } catch (err) {
      failed.push({ path: p, message: trimErr(err) });
    }
  }
  return { reverted, failed };
}

// ---------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------

interface TrackedFileEntry {
  /** Blob hash at HEAD (from `git ls-tree -r HEAD`). */
  readonly headHash: string;
  /** Blob hash of the working-tree copy (from `git hash-object`).
   *  Equals headHash when file is clean; differs when dirty. */
  readonly workingHash: string;
}

async function readTrackedFileHashes(
  repoPath: string,
): Promise<
  | { ok: true; entries: ReadonlyMap<string, TrackedFileEntry> }
  | { ok: false; error: 'repo_not_found' | 'git_error'; message: string }
> {
  // 1. Read HEAD-tracked files + their HEAD blob hashes.
  //    `git ls-tree -r HEAD` emits one line per blob:
  //      `<mode> <type> <hash>\t<path>`
  let headLines = '';
  try {
    const r = await execFileAsync(
      'git',
      ['-C', repoPath, 'ls-tree', '-r', 'HEAD'],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    );
    headLines = r.stdout;
  } catch (err) {
    const e = err as { stderr?: string };
    if (/not a git repository/i.test(e.stderr ?? '')) {
      return {
        ok: false,
        error: 'repo_not_found',
        message: `"${repoPath}" is not a git repository.`,
      };
    }
    return {
      ok: false,
      error: 'git_error',
      message: `git ls-tree -r HEAD failed: ${trimErr(err)}`,
    };
  }

  // 2. Read the WORKING TREE blob hash for every file under git's
  //    knowledge. `git hash-object --stdin-paths` consumes paths on
  //    stdin and emits hashes line-by-line — much faster than per-
  //    file forks for large repos. But it only sees files that
  //    EXIST on disk; deleted-and-not-yet-staged files won't appear.
  //    For our purpose (detect agent writes), that's fine; the
  //    deletion case is handled by the audit's "baseline path is
  //    missing now" branch.
  type Row = { path: string; headHash: string };
  const rows: Row[] = [];
  for (const line of headLines.split('\n')) {
    if (!line.trim()) continue;
    // `<mode> <type> <hash>\t<path>`
    const tabIdx = line.indexOf('\t');
    if (tabIdx < 0) continue;
    const meta = line.slice(0, tabIdx).split(' ');
    if (meta.length < 3) continue;
    const headHash = meta[2]!;
    const path = line.slice(tabIdx + 1);
    rows.push({ path, headHash });
  }

  // Batch the hash-object call — but ONLY for files that still
  // exist on disk. `git hash-object --stdin-paths` errors out on a
  // missing path and aborts the whole batch, which would mask
  // deleted-file leaks. Pre-filter so deleted files are silently
  // omitted; the audit's "baseline path missing now" branch picks
  // them up downstream.
  const pathsOnDisk = rows
    .filter((r) => existsSync(join(repoPath, r.path)))
    .map((r) => r.path);
  const workingHashes = await batchHashObject(repoPath, pathsOnDisk);
  if (!workingHashes.ok) return workingHashes;

  const entries = new Map<string, TrackedFileEntry>();
  for (const r of rows) {
    const workingHash = workingHashes.hashes.get(r.path);
    // workingHash undefined = file deleted from disk. Don't include
    // — the audit's "missing baseline path" branch handles it.
    if (workingHash === undefined) continue;
    entries.set(r.path, { headHash: r.headHash, workingHash });
  }
  return { ok: true, entries };
}

async function batchHashObject(
  repoPath: string,
  paths: readonly string[],
): Promise<
  | { ok: true; hashes: ReadonlyMap<string, string> }
  | { ok: false; error: 'git_error'; message: string }
> {
  if (paths.length === 0) return { ok: true, hashes: new Map() };
  // Use --stdin-paths so we get one stable child for all files.
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-C', repoPath, 'hash-object', '--stdin-paths'],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({
            ok: false,
            error: 'git_error',
            message: `git hash-object --stdin-paths failed: ${trimErr(err)}`,
          });
          return;
        }
        const lines = stdout.split('\n').filter((l) => l.length > 0);
        const hashes = new Map<string, string>();
        for (let i = 0; i < paths.length && i < lines.length; i++) {
          hashes.set(paths[i]!, lines[i]!);
        }
        resolve({ ok: true, hashes });
      },
    );
    if (child.stdin) {
      child.stdin.write(paths.join('\n') + '\n');
      child.stdin.end();
    }
  });
}

function trimErr(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; message?: string };
    if (typeof e.stderr === 'string' && e.stderr.length > 0) return e.stderr.trim();
    if (typeof e.message === 'string') return e.message.trim();
  }
  return String(err);
}

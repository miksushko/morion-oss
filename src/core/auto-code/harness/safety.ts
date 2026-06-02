/**
 * Auto-code CLI Agent Harness — process-safety helpers (L1.T7).
 *
 * Two layers, applied at the harness perimeter NOT inside individual
 * adapters (`AbstractAgentHandle` consumes both):
 *
 *   1. **Per-worktree lockfile.** When `withWorktreeLock(cwd)` is
 *      called before spawn, it reads `<cwd>/.morion-harness.lock`. If
 *      a prior PID is recorded and still alive, SIGTERM → 3s wait →
 *      SIGKILL fallback. Then writes our own PID. Releases on clean
 *      handle close. Prevents two concurrent harness runs in the
 *      same worktree (which corrupts git state and produces
 *      ambiguous diffs). Same shape as `src/server/sidecar-lockfile.ts`
 *      adapted to per-cwd granularity instead of one global lock.
 *
 *   2. **Spawn registry + exit hook.** Every successful spawn
 *      registers `(pid, killFn)` in a module-scoped Set. On normal
 *      Node `'exit'` event (Ctrl-C, programmatic `process.exit`,
 *      uncaught exception with crash handler, etc.) we iterate the
 *      registry and SIGKILL every still-running child. Best-effort
 *      cleanup — handles graceful + most crash paths but NOT
 *      SIGKILL of our own parent (the kernel doesn't run our exit
 *      handlers when we're SIGKILL'd ourselves). For that path,
 *      lessons.md "Disable Mo Concierge + zombie sidecar prevention"
 *      documents the existing 3-layer defence at the sidecar
 *      perimeter (orphan-watch + lockfile + Tauri Drop).
 *
 * **Why no orphan-watch on agent processes?** The pattern from
 * `src/server/orphan-watch.ts` requires the watched process to RUN
 * its own ppid polling. CLI agents (claude, codex, pi, opencode) are
 * external binaries we don't control — we can't inject our watch
 * code. Parent-side cleanup is the realistic v1 strategy.
 *
 * Test convenience: `safety.ts` exports a `_resetForTests()` to
 * clear the module-scoped registry between test runs.
 */

import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  closeSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

const LOCK_FILENAME = '.morion-harness.lock';
const SIGTERM_GRACE_MS = 3_000;

// ---------------------------------------------------------------------
// Per-worktree lockfile
// ---------------------------------------------------------------------

export interface WorktreeLock {
  /** Path to the lockfile this lock owns. */
  readonly path: string;
  /** Release the lock (delete file iff still ours). Idempotent. */
  release(): void;
}

export interface AcquireWorktreeLockOptions {
  /** Override `process.kill` (test injection). */
  killProbe?: (pid: number, signal: 0 | 'SIGTERM' | 'SIGKILL') => boolean;
  /** Override sleep (test injection). Production busy-waits via
   *  `Atomics.wait`. */
  sleepMs?: (ms: number) => void;
  /** Time to wait for prior PID to exit cleanly after SIGTERM
   *  before SIGKILL. Default 3s. */
  termWaitMs?: number;
  /** Run identity stamped into the lockfile alongside PID, for
   *  diagnostic purposes (`{pid, runId, startedAt}` JSON). */
  runId?: string;
}

/**
 * Error thrown when a worktree lock cannot be acquired because
 * another in-process harness handle is currently holding it. The
 * caller should NOT retry blindly — same-process contention means
 * the workflow runner has scheduled two concurrent stages into the
 * same worktree, which is a logic bug at the L2 layer.
 *
 * Cross-process contention (different `process.pid`) goes through
 * the SIGTERM → SIGKILL reap chain instead — reaching this error
 * specifically means same-PID contention.
 */
export class WorktreeLockBusyError extends Error {
  constructor(
    public readonly cwd: string,
    public readonly heldByRunId: string | null,
  ) {
    super(
      `worktree lock at ${cwd} is held by a same-process handle (runId=${heldByRunId ?? 'unknown'}). ` +
        `Two harness handles cannot share a worktree.`,
    );
    this.name = 'WorktreeLockBusyError';
  }
}

/**
 * Acquire a lock on the worktree at `cwd`. Returns a `WorktreeLock`
 * whose `release()` removes the file iff we still own it (matches
 * BOTH pid AND owner-token).
 *
 * Atomic ownership: lockfile is created via `openSync` with `wx`
 * flag (fail if exists) — this prevents two same-process handles
 * racing into the same worktree. Cross-process contention goes
 * through the SIGTERM/SIGKILL reap chain (prior PID dead → take
 * over; alive → SIGTERM with grace period). Same-PID contention
 * (two handles in this Morion sidecar) throws
 * `WorktreeLockBusyError` — this is a logic bug at the caller
 * level (workflow runner shouldn't schedule concurrent stages on
 * the same worktree) and should NOT be retried blindly.
 *
 * Codex T10 review P1 fix: pre-fix used overwrite-on-write, which
 * let a same-process second handle clobber the first's lockfile,
 * after which the first's release() would delete the second's
 * lock by PID-only check.
 *
 * Synchronous by design — must complete BEFORE the agent CLI is
 * spawned, otherwise two harness runs could overlap on the same
 * worktree (corrupting git state).
 *
 * Throws on:
 *   - `WorktreeLockBusyError` — same-process contention
 *   - generic Error — filesystem failure (permission, disk full)
 */
export function acquireWorktreeLock(
  cwd: string,
  opts: AcquireWorktreeLockOptions = {},
): WorktreeLock {
  const lockPath = join(cwd, LOCK_FILENAME);
  // Add `.morion-harness.lock` to git's per-worktree excludes
  // BEFORE we write the file. Without this, an agent that runs
  // `git add -A && git commit` inside the worktree (Pi / Claude /
  // Codex all do this when told to commit their diff) will sweep
  // up the lockfile and bake `pid` / `runId` / `ownerToken` into
  // the user's git history — see 2026-05-11 incident on Echo Drop
  // ticket `01KRBTX5AWXEERRS7409QCGC9C`, where commit f44d3d0
  // included `.morion-harness.lock |   1 +` alongside the legit
  // game.js changes. Idempotent — re-running on a worktree that
  // already has the rule is a no-op. Best-effort: silent failure
  // is fine (lockfile still works; agent might still leak it,
  // but the auto-commit defensive unstage in merge.ts catches it
  // as layer 2).
  ensureLockfileIgnored(cwd);
  const killProbe = opts.killProbe ?? defaultKillProbe;
  const sleepMs = opts.sleepMs ?? defaultSleepSync;
  const termWaitMs = opts.termWaitMs ?? SIGTERM_GRACE_MS;
  const myPid = process.pid;
  const myRunId = opts.runId ?? '';
  // Per-acquire owner token: distinguishes lock instances even
  // when pid + runId are reused by tests. Stored alongside pid in
  // the lockfile; release() requires both to match.
  const myOwnerToken = randomBytes(16).toString('hex');

  // Ensure the directory exists — caller is supposed to have set up
  // the worktree but we're defensive.
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // Already exists OR permission issue — proceed and let the
    // writeFileSync below throw with a clearer error.
  }

  const payload = JSON.stringify({
    pid: myPid,
    runId: myRunId,
    ownerToken: myOwnerToken,
    startedAt: Date.now(),
  });

  // Try atomic create-or-fail first. If it succeeds, we own the
  // lock cleanly without touching anything.
  if (tryAtomicCreate(lockPath, payload)) {
    return makeReleaser(lockPath, myPid, myOwnerToken);
  }

  // File exists. Read it to decide policy: same-pid contention
  // (throw) or cross-pid stale lock (reap + retry).
  let prior: { pid?: number; runId?: string; ownerToken?: string } | null =
    null;
  try {
    prior = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      pid?: number;
      runId?: string;
      ownerToken?: string;
    };
  } catch {
    // Corrupt lockfile — treat as stale. Delete + retry create.
    try {
      unlinkSync(lockPath);
    } catch {
      // race
    }
    if (tryAtomicCreate(lockPath, payload)) {
      return makeReleaser(lockPath, myPid, myOwnerToken);
    }
    // If create still fails, fall through to throw at the end.
  }

  if (prior && typeof prior.pid === 'number' && prior.pid === myPid) {
    // Same-process contention — workflow runner should never
    // schedule this. Throw with a clear error.
    throw new WorktreeLockBusyError(cwd, prior.runId ?? null);
  }

  if (prior && typeof prior.pid === 'number' && prior.pid > 0) {
    const priorPid = prior.pid;
    const alive = killProbe(priorPid, 0);
    if (alive) {
      // Cross-process stale lock with running PID. SIGTERM, wait,
      // SIGKILL fallback.
      try {
        killProbe(priorPid, 'SIGTERM');
      } catch {
        // race
      }
      const deadline = Date.now() + termWaitMs;
      while (Date.now() < deadline) {
        if (!killProbe(priorPid, 0)) break;
        sleepMs(100);
      }
      if (killProbe(priorPid, 0)) {
        try {
          killProbe(priorPid, 'SIGKILL');
        } catch {
          // race
        }
        sleepMs(100);
      }
    }
    // Either way (was dead, or now killed), remove stale file.
    try {
      unlinkSync(lockPath);
    } catch {
      // race vs another acquirer; handled by retry below
    }
  } else {
    // Garbage we couldn't even parse PID from. Best effort delete.
    try {
      unlinkSync(lockPath);
    } catch {
      // race
    }
  }

  // Retry atomic create after reaping. If THIS still fails, the
  // file appeared again concurrently — surface as filesystem error.
  if (tryAtomicCreate(lockPath, payload)) {
    return makeReleaser(lockPath, myPid, myOwnerToken);
  }

  throw new Error(
    `failed to acquire worktree lockfile at ${lockPath} after reaping prior holder`,
  );
}

/**
 * Append `.morion-harness.lock` to the worktree's git exclude file
 * if not already present. `.git/info/exclude` is git's local-only
 * ignore file — it's NOT itself tracked, so it doesn't pollute the
 * user's repo, but `git add -A` / `git add .` honors it.
 *
 * For worktrees (where `<cwd>/.git` is a file pointing at the main
 * repo's gitdir), we resolve the actual exclude path via
 * `git rev-parse --git-common-dir` — this returns the shared gitdir
 * for the repo so the same `info/exclude` applies across every
 * worktree. Idempotent: skip if the rule line is already present.
 *
 * Failure modes (all silent — best effort):
 *   - cwd is not a git repo → execFileSync throws, we swallow.
 *   - `info/` dir doesn't exist → mkdirSync ensures it.
 *   - file is read-only → writeFileSync throws, we swallow.
 *
 * Defence-in-depth: even if this fails to write, the auto-commit
 * step in `merge.ts` / `merge-conflict-resolver.ts` separately
 * unstages `.morion-harness.lock` before commit.
 */
export function ensureLockfileIgnored(cwd: string): void {
  const RULE = `/${LOCK_FILENAME}`;
  let commonDir: string;
  try {
    commonDir = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8', timeout: 5_000 },
    ).trim();
  } catch {
    return;
  }
  // `git rev-parse --git-common-dir` returns a path relative to
  // cwd when possible; resolve against cwd if it's not absolute.
  const absoluteCommonDir = commonDir.startsWith('/')
    ? commonDir
    : join(cwd, commonDir);
  const excludePath = join(absoluteCommonDir, 'info', 'exclude');
  try {
    mkdirSync(dirname(excludePath), { recursive: true });
  } catch {
    // Already exists or permission — proceed; writeFileSync below
    // will surface if it's truly broken.
  }
  let existing = '';
  try {
    if (existsSync(excludePath)) {
      existing = readFileSync(excludePath, 'utf8');
    }
  } catch {
    existing = '';
  }
  // Skip if rule already present (also accept the unanchored
  // variant `.morion-harness.lock` for back-compat with hand-edited
  // exclude files).
  const lines = existing.split('\n').map((l) => l.trim());
  if (lines.includes(RULE) || lines.includes(LOCK_FILENAME)) return;
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const next = `${existing}${sep}${RULE}\n`;
  try {
    writeFileSync(excludePath, next, 'utf8');
  } catch {
    // Best effort — layer 2 (auto-commit unstage in merge.ts) catches
    // the leak if this fails.
  }
}

/** Atomic create-or-fail. Returns true on success, false if file
 *  already exists. Throws on other filesystem errors. */
function tryAtomicCreate(path: string, payload: string): boolean {
  try {
    const fd = openSync(path, 'wx');
    try {
      writeFileSync(fd, payload, 'utf8');
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

function makeReleaser(
  lockPath: string,
  myPid: number,
  myOwnerToken: string,
): WorktreeLock {
  return {
    path: lockPath,
    release(): void {
      // Delete iff BOTH pid AND ownerToken match. Codex T10
      // review P1: pid-only check let a first handle delete a
      // second same-pid handle's lock.
      try {
        if (!existsSync(lockPath)) return;
        const raw = readFileSync(lockPath, 'utf8');
        const parsed = JSON.parse(raw) as {
          pid?: number;
          ownerToken?: string;
        };
        if (
          parsed.pid === myPid &&
          parsed.ownerToken === myOwnerToken
        ) {
          unlinkSync(lockPath);
        }
      } catch {
        // race / corrupt / not ours — leave it alone.
      }
    },
  };
}

function defaultKillProbe(
  pid: number,
  signal: 0 | 'SIGTERM' | 'SIGKILL',
): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // Other errors (EPERM): treat as "alive but unkillable from
    // here". Caller will proceed best-effort.
    return true;
  }
}

function defaultSleepSync(ms: number): void {
  // Synchronous sleep without async machinery — needed because
  // acquireWorktreeLock runs before the spawn promise chain starts.
  // Implementation: shared-array Atomics.wait (Node 16+).
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

// ---------------------------------------------------------------------
// Spawn registry + exit hook
// ---------------------------------------------------------------------

interface RegisteredChild {
  pid: number;
  /** Adapter name for diagnostic logging. */
  agent: string;
}

const REGISTRY = new Set<RegisteredChild>();
let exitHookInstalled = false;

/** Register a spawned child for cleanup on parent exit.
 *
 *  Called by `AbstractAgentHandle` immediately after a successful
 *  spawn. The corresponding `unregisterChild()` runs from the
 *  child's `'close'` event handler — matched pair, no leak. */
export function registerChild(pid: number, agent: string): RegisteredChild {
  ensureExitHook();
  const entry: RegisteredChild = { pid, agent };
  REGISTRY.add(entry);
  return entry;
}

/** Unregister a child after it has reaped. Idempotent. */
export function unregisterChild(entry: RegisteredChild): void {
  REGISTRY.delete(entry);
}

/** Install the `process.on('exit')` handler exactly once per
 *  process lifetime. */
function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    // Synchronous handler — no async work allowed. Iterate the
    // registry and SIGKILL each child. Errors swallowed (process
    // is exiting; logging won't reach the user reliably).
    for (const child of REGISTRY) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // already dead / EPERM — no-op
      }
    }
    REGISTRY.clear();
  });
}

/** Test-only — clears the registry + resets exit-hook state.
 *  NEVER call from production code. */
export function _resetForTests(): void {
  REGISTRY.clear();
  exitHookInstalled = false;
}

/** Test-only — snapshot of currently-registered children. */
export function _snapshotRegistry(): readonly RegisteredChild[] {
  return [...REGISTRY];
}

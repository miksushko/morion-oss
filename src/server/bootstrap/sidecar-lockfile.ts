/**
 * Sidecar lockfile + reap-prior on startup.
 *
 * Companion to `orphan-watch.ts`. ppid polling catches zombies AT
 * RUNTIME — but that only helps the sidecar itself notice it's been
 * abandoned. It doesn't help if the user's previous sidecar is
 * already a zombie at the moment the user re-launches Morion.app
 * (because the first session crashed before installing the watch,
 * because the user is running an old build that pre-dates this
 * defence, or just because timing).
 *
 * The lockfile pattern handles that: every `morion serve` writes its
 * PID to `<configDir>/morion-serve.pid` on startup. The next sidecar
 * that starts reads the file, probes whether the prior PID is still
 * running, SIGTERMs it if so, waits briefly, then continues. The
 * file itself is removed on clean shutdown — so the absence of the
 * file is the steady-state.
 *
 * Real incident this is defending against (ticket
 * `01KQVA65TJ2VCY8VCKH9N5F6W8`, 2026-05-05): one user accumulated 21
 * `morion serve` zombies over 24 days of .app re-launches. The
 * oldest had pre-deletion `runConciergeTick` code in memory and was
 * burning ~2000 Gemini Flash Lite calls/day against the user's
 * OpenRouter key. With this lockfile, every Morion.app launch would
 * have reaped the prior sidecar, and only one would have ever
 * existed at a time.
 *
 * Scope: HTTP sidecars only. Stdio MCP sidecars (`morion mcp`) have
 * legitimate multi-instance use — every MCP client (Claude Desktop,
 * Cursor, Codex) spawns its own. They're handled by stdin EOF +
 * ppid polling in `orphan-watch.ts`.
 *
 * Not used in test harnesses (`disableScheduler: true` on
 * `startHttpServer` skips the call site). Tests build hundreds of
 * in-memory runtimes per run; locking would serialize them and
 * obscure failures.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ReapOptions {
  /** Override the kill probe (test injection). Production uses
   *  `process.kill(pid, signal)`. Returns `true` if the kill / probe
   *  succeeded (process exists), `false` if ESRCH (gone). */
  killProbe?: (pid: number, signal: 0 | 'SIGTERM' | 'SIGKILL') => boolean;
  /** Override sleep (test injection). Production busy-waits via a
   *  blocking SharedArrayBuffer Atomics.wait. */
  sleepMs?: (ms: number) => void;
  /** Override log sink. Production writes to stderr. */
  log?: (msg: string) => void;
  /** How long to wait for SIGTERM to take effect before falling back
   *  to SIGKILL. Default 3000ms — long enough for the prior sidecar
   *  to flush WAL + close the DB cleanly, short enough that a launch
   *  doesn't visibly hang. */
  termWaitMs?: number;
}

/**
 * Synchronously reap a stale prior sidecar referenced by
 * `<configDir>/morion-serve.pid`, then write our own PID.
 *
 * Synchronous (NOT async) by design: this runs BEFORE
 * `serve()` binds the port. An async version would let us serve
 * the first request while the old sidecar is still holding writes
 * on the same SQLite file. Sync busy-wait is acceptable because the
 * total time is bounded (≤ termWaitMs ≈ 3s).
 *
 * Idempotent: if the lockfile points at our own PID, no-op. If the
 * prior PID is dead, just overwrite. If alive, SIGTERM → wait →
 * SIGKILL fallback.
 *
 * Errors during the kill / wait phase are logged but don't abort
 * startup — the new sidecar takes over best-effort. The only fatal
 * case is being unable to write our own PID (filesystem broken),
 * which throws.
 */
export function reapPriorAndLock(
  configDir: string,
  opts: ReapOptions = {},
): void {
  const lockfile = join(configDir, 'morion-serve.pid');
  const log = opts.log ?? ((msg) => process.stderr.write(`${msg}\n`));
  const killProbe =
    opts.killProbe ??
    ((pid, signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    });
  // sleepSync via Atomics.wait — works in Node 16+, no native deps.
  const sleepMs =
    opts.sleepMs ??
    ((ms) => {
      const sab = new SharedArrayBuffer(4);
      const arr = new Int32Array(sab);
      Atomics.wait(arr, 0, 0, ms);
    });
  const termWaitMs = opts.termWaitMs ?? 3000;

  // Step 1: read the prior pidfile if any.
  let priorPid: number | null = null;
  if (existsSync(lockfile)) {
    try {
      const raw = readFileSync(lockfile, 'utf8').trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) priorPid = parsed;
    } catch (err) {
      log(
        `[sidecar-lockfile] could not read prior pidfile: ${(err as Error).message}`,
      );
    }
  }

  // Step 2: if a prior PID exists and it's not us, reap it.
  if (priorPid !== null && priorPid !== process.pid) {
    const alive = killProbe(priorPid, 0);
    if (alive) {
      log(
        `[sidecar-lockfile] prior sidecar pid=${priorPid} still alive, sending SIGTERM`,
      );
      killProbe(priorPid, 'SIGTERM');
      // Poll until it's gone, capped at termWaitMs.
      const deadline = Date.now() + termWaitMs;
      while (Date.now() < deadline) {
        if (!killProbe(priorPid, 0)) break;
        sleepMs(100);
      }
      if (killProbe(priorPid, 0)) {
        log(
          `[sidecar-lockfile] prior sidecar pid=${priorPid} ignored SIGTERM after ${termWaitMs}ms, SIGKILL fallback`,
        );
        killProbe(priorPid, 'SIGKILL');
        // Brief grace for the kill to land.
        sleepMs(100);
      } else {
        log(
          `[sidecar-lockfile] prior sidecar pid=${priorPid} exited cleanly`,
        );
      }
    }
  }

  // Step 3: write our own PID.
  writeFileSync(lockfile, String(process.pid), 'utf8');

  // Step 4: clean up on exit. Both 'exit' (sync, last resort) and
  // an explicit unlink in the shutdown hook (async, preferred path)
  // try to remove the file; whichever runs first wins.
  process.on('exit', () => {
    try {
      const current = readFileSync(lockfile, 'utf8').trim();
      // Only delete if it still points at us — avoid race where a
      // newer sidecar already wrote its own PID and we'd nuke its
      // lock on our delayed exit.
      if (current === String(process.pid)) {
        unlinkSync(lockfile);
      }
    } catch {
      // file gone, never written, race with newer sidecar — all fine.
    }
  });
}

/**
 * Best-effort lockfile cleanup for the async shutdown path. Called
 * from `StartedServer.shutdown` BEFORE `db.close()` so a future
 * launch can reap us cleanly even if our `process.on('exit')` hook
 * doesn't run (e.g. force-kill mid-shutdown).
 */
export function releaseLock(configDir: string): void {
  const lockfile = join(configDir, 'morion-serve.pid');
  try {
    if (!existsSync(lockfile)) return;
    const current = readFileSync(lockfile, 'utf8').trim();
    if (current === String(process.pid)) {
      unlinkSync(lockfile);
    }
  } catch {
    // best-effort — never block shutdown on lockfile cleanup
  }
}

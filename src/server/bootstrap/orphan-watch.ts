/**
 * Orphan-detection helpers for Morion sidecar processes.
 *
 * Failure mode this exists to prevent: zombie sidecars surviving after
 * the parent process (Tauri shell, MCP client like Claude Desktop /
 * Cursor / Codex) dies WITHOUT sending a clean SIGTERM. Without
 * detection, these zombies keep running their `ConciergeScheduler`
 * indexing tick and any pre-2026-05-03 build's autonomous Mo
 * agent — burning user budget invisibly until the next OS reboot.
 *
 * Real incident 2026-05-05 (ticket `01KQVA65TJ2VCY8VCKH9N5F6W8`):
 * one user accumulated 21 `morion serve` + 10 `morion mcp` zombies
 * over 24 days of dev/.app cycles. The oldest had pre-deletion
 * `runConciergeTick` code in memory and was firing ~2000
 * Gemini Flash Lite calls/day against the user's OpenRouter key.
 *
 * Two detection strategies, both portable across macOS/Linux/Windows
 * via pure Node:
 *
 *   1. **ppid polling** — every `intervalMs` we read `process.ppid`.
 *      On Unix, when the parent dies the kernel re-parents us to
 *      pid 1 (init / launchd). On Windows it doesn't, but
 *      `process.ppid` reflects whatever the OS reports — when the
 *      Tauri shell exits, the child is orphaned to the desktop manager
 *      (explorer.exe) and the ppid changes. Either signal triggers
 *      shutdown. Cheap, stateless, doesn't depend on stdio plumbing.
 *
 *   2. **stdin EOF detection** — reliable for stdio MCP sidecars that
 *      receive their JSON-RPC traffic on stdin. When the parent
 *      closes the pipe (intentionally OR by dying), Node fires the
 *      `'end'` event. Faster than ppid polling (microseconds vs
 *      seconds) for stdio cases. Doesn't help HTTP sidecars where
 *      stdin is the user's terminal (interactive) or null (Tauri
 *      spawn) — for those, ppid polling is the right tool.
 *
 * Belt-and-braces: stdio sidecars get BOTH stdin EOF AND ppid polling
 * — stdin can stay open in some MCP-client edge cases (e.g. parent
 * crashed but the stdio pipe inherited by another process), and
 * we want defence in depth.
 *
 * The helpers return a `dispose()` so tests can stop the timer +
 * stdin listener cleanly. Production code never calls dispose — the
 * watch lives the lifetime of the process.
 */

export interface OrphanWatchOptions {
  /** Called when orphan is detected. Caller is expected to start an
   *  async shutdown (close DB, stop scheduler, etc) and then exit. */
  onOrphan: (reason: 'ppid_changed' | 'ppid_init' | 'stdin_eof') => void;
  /** Override poll interval for ppid checks. Default 5000ms — fast
   *  enough that a runaway zombie burns at most ~5s of LLM budget
   *  before self-kill, slow enough that the timer cost is invisible. */
  intervalMs?: number;
  /** Override the initial ppid (test injection). Production reads
   *  `process.ppid` once at install time. */
  initialPpid?: number;
  /** Override the ppid getter (test injection). Production uses
   *  `() => process.ppid`. */
  getPpid?: () => number;
  /** Optional log sink — defaults to `console.error` so messages land
   *  on stderr (does NOT corrupt MCP stdio JSON-RPC). */
  log?: (msg: string) => void;
}

/**
 * Watch for parent-process death via ppid polling. Use for HTTP
 * sidecars (`morion serve`, `npm run dev:server`) where stdin isn't a
 * meaningful signal.
 *
 * Returns a `dispose()` function that stops the timer. Tests use it;
 * production never calls it.
 */
export function watchParentViaPpid(opts: OrphanWatchOptions): () => void {
  const intervalMs = opts.intervalMs ?? 5000;
  const getPpid = opts.getPpid ?? (() => process.ppid);
  const initialPpid = opts.initialPpid ?? getPpid();
  const log = opts.log ?? ((msg) => process.stderr.write(`${msg}\n`));

  // Don't watch if we're already orphaned at startup (initialPpid===1)
  // — that's a legitimate "started by launchd / systemd" case.
  if (initialPpid === 1 || initialPpid === 0) {
    log(
      `[orphan-watch] not arming ppid watch — initialPpid=${initialPpid} (we were already detached at startup)`,
    );
    return () => {};
  }

  let fired = false;
  const timer = setInterval(() => {
    if (fired) return;
    let current: number;
    try {
      current = getPpid();
    } catch {
      // Some platforms throw on ppid read in edge states — don't
      // crash the sidecar over a transient ppid error.
      return;
    }
    // ppid=1 (Unix) means kernel re-parented us to init/launchd —
    // unambiguous orphan signal.
    if (current === 1) {
      fired = true;
      log(`[orphan-watch] ppid=1 (kernel re-parented to init), parent died`);
      opts.onOrphan('ppid_init');
      return;
    }
    // ppid changed at all = parent gone (Windows + macOS edge cases
    // where the shell didn't get re-parented to init but to some
    // other user-space process like the dock).
    if (current !== initialPpid) {
      fired = true;
      log(
        `[orphan-watch] ppid changed (${initialPpid} → ${current}), parent died`,
      );
      opts.onOrphan('ppid_changed');
      return;
    }
  }, intervalMs);
  // unref so the watch timer doesn't keep the event loop alive on its
  // own — if all real work has finished, Node should still exit cleanly
  // without the watch artificially pinning it.
  timer.unref?.();

  return () => clearInterval(timer);
}

export interface StdioOrphanWatchOptions extends OrphanWatchOptions {
  /** Override stdin (test injection). Production uses
   *  `process.stdin`. */
  stdin?: NodeJS.ReadableStream;
}

/**
 * Watch for parent-process death on a stdio sidecar (`morion mcp`).
 * Combines stdin EOF detection (fast, fires within ms of pipe close)
 * with ppid polling (defence-in-depth: covers the case where stdin
 * stays open but the parent died anyway, e.g. parent crashed mid-write
 * and the OS held the pipe for cleanup).
 *
 * Returns a `dispose()` function that removes both watchers.
 *
 * IMPORTANT: don't call this from a non-stdio context. The MCP stdio
 * transport already reads `process.stdin` for JSON-RPC frames, and
 * adding another `'end'` listener is fine (Node supports multiple
 * listeners on the same emitter). What's NOT fine is calling this
 * from `morion serve` where stdin is the user's terminal — closing
 * it via Ctrl+D would falsely fire the orphan handler.
 */
export function watchParentViaStdioAndPpid(
  opts: StdioOrphanWatchOptions,
): () => void {
  const log = opts.log ?? ((msg) => process.stderr.write(`${msg}\n`));
  const stdin = opts.stdin ?? process.stdin;
  let fired = false;

  // Layer 1: stdin EOF — the fast path.
  const onEnd = (): void => {
    if (fired) return;
    fired = true;
    log('[orphan-watch] stdin EOF, parent gone');
    opts.onOrphan('stdin_eof');
  };
  stdin.on?.('end', onEnd);

  // Layer 2: ppid polling — backup for the case where stdin stays
  // open after parent death. Re-arms `fired` shared with stdin EOF
  // so we don't double-fire onOrphan.
  const ppidDispose = watchParentViaPpid({
    ...opts,
    onOrphan: (reason) => {
      if (fired) return;
      fired = true;
      log(`[orphan-watch] ppid signal (${reason}) — parent gone`);
      opts.onOrphan(reason);
    },
  });

  return () => {
    stdin.off?.('end', onEnd);
    ppidDispose();
  };
}

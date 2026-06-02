import { buildRuntime } from '../core/runtime.js';
import { startHttpServer } from './bootstrap/start.js';
import { watchParentViaPpid } from './bootstrap/orphan-watch.js';

/**
 * Thin wrapper around `startHttpServer` for `npm run dev:server` via
 * tsx watch. MCP stdio is NOT started here — it would corrupt stdout
 * under tsx watch. The CLI `morion mcp` subcommand runs a stdio-only
 * variant; both processes share the same SQLite file via WAL mode so
 * multi-process concurrency is safe.
 *
 * The production surface (Tauri shell, `morion serve`) goes through
 * `src/cli/index.ts`, which also calls `startHttpServer`. Keep both
 * entrypoints minimal so they can't drift again — see
 * `tasks/lessons.md` 2026-04-14 "Duplicated server entrypoints drifted"
 * for the regression that made us unify this.
 */
async function main(): Promise<void> {
  const rt = buildRuntime();
  const started = startHttpServer(rt);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[morion] ${signal} received, closing DB and exiting`);
    // Await so the scheduler's inflight ticks finish before
    // process.exit kills the event loop. Old sync `started.shutdown()`
    // would race the SIGTERM-to-exit window and lose mid-transaction
    // brief writes. Ticket `01KQ1H4YVKJFVE05PG9WZBAB7E`.
    await started.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Orphan detection: if our parent (the npm-script orchestrator,
  // tsx watch, or terminal shell) dies WITHOUT sending SIGTERM
  // (e.g. terminal force-quit, IDE crash, OS sleep+wake glitch),
  // ppid polling catches us re-parented to init and triggers a
  // clean shutdown. Without this, dev sidecars accumulate as
  // zombies that keep firing the indexing tick. See ticket
  // `01KQVA65TJ2VCY8VCKH9N5F6W8` (2026-05-05) for the real
  // incident — 21 prod + 9 dev zombies caught one user.
  watchParentViaPpid({
    onOrphan: (reason) => void shutdown(`orphan(${reason})`),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

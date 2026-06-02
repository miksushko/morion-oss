/**
 * Single source of truth for "start the Morion HTTP server".
 *
 * Historically this lived in two places:
 *   - `src/server/index.ts` — the minimal standalone entrypoint, used
 *     by `npm run dev:server` via tsx watch.
 *   - `src/cli/index.ts serve` — the production entrypoint, spawned by
 *     the Tauri shell and invoked by `morion serve`.
 *
 * Both did the same thing: buildHttpApp → serve → setupWalWatcher →
 * graceful shutdown. In 2026-04-14 they drifted — the CLI fork was
 * added later and its copy-paste of `serve()` silently dropped the
 * WAL watcher line. Live sync was broken for every user on the
 * production path until someone noticed `/api/events` returned
 * `200 OK text/html` instead of `101 Switching Protocols`. See
 * `tasks/lessons.md` 2026-04-14 "Duplicated server entrypoints drifted".
 *
 * After R3 both entrypoints go through this function. Any future
 * addition (another middleware, a CORS tweak, a shutdown hook)
 * happens here once, not twice.
 */
import { serve, type ServerType } from '@hono/node-server';
import type { FSWatcher } from 'node:fs';
import type { WebSocketServer } from 'ws';
import { dirname } from 'node:path';
import type { Runtime } from '../../core/runtime.js';
import { ConciergeScheduler } from '../../core/concierge/index.js';
import {
  buildMoIndexingDeps,
  buildTopicHygienePoll,
  type ConciergeDepsHost,
} from '../features/concierge-deps/index.js';
import { buildHttpApp } from './http.js';
import { setupWalWatcher } from './ws.js';
import { reapPriorAndLock, releaseLock } from './sidecar-lockfile.js';
import { autoCodeSchedulerWiring } from '../features/auto-code-scheduler/index.js';

export interface StartedServer {
  server: ServerType;
  watcher: FSWatcher | null;
  wss: WebSocketServer;
  /**
   * Mo Concierge scheduler — `null` when the runtime didn't wire the
   * concierge bag (legacy callers / tests built before V1). Production
   * always has it. Lifetime tied to the HTTP server: started before
   * `startHttpServer` returns, stopped (and awaited) inside `shutdown()`.
   */
  scheduler: ConciergeScheduler | null;
  /**
   * Flush WAL + close the DB handle + stop the watcher + close every
   * WebSocket client + STOP THE SCHEDULER (awaiting any inflight ticks
   * + brief digests so we don't kill a transaction mid-way). Idempotent —
   * safe to call from a SIGTERM handler and then again from
   * `process.on('exit', ...)`.
   *
   * Returns a Promise: callers MUST `await` before calling `process.exit`
   * or the scheduler's inflight work gets cut off. The previous sync
   * signature was a bug — `ConciergeScheduler.stop()` is async, and a
   * sync close would lose any tick mid-transaction.
   *
   * We swallow errors from db.close() and watcher.close() because there's
   * nothing left to do about them at this point in the lifecycle. They're
   * logged to stderr so tauri/systemd/etc can attribute them if needed.
   */
  shutdown: () => Promise<void>;
}

export interface StartHttpServerOptions {
  /**
   * Called once when the HTTP listener is ready, with the resolved
   * host + port. Default: log to stdout (what both historical
   * entrypoints did). Pass `undefined` to keep the default; pass
   * a noop to silence (tests).
   */
  onReady?: (info: { address: string; port: number }) => void;
  /**
   * Override the scheduler poll interval. Production leaves this unset
   * (the scheduler defaults to 30s); tests pass a sub-second value to
   * make the timer-folder-ticks regression test fast.
   */
  schedulerPollIntervalMs?: number;
  /**
   * Skip starting the scheduler entirely. Tests that just exercise the
   * HTTP surface use this so a stale per-test scheduler doesn't keep
   * firing into an in-memory DB after the test ends. Defaults to false.
   */
  disableScheduler?: boolean;
  /**
   * Skip the sidecar lockfile (reap-prior-on-startup). Tests build
   * many in-memory runtimes per run; reaping each other would
   * serialize them and obscure failures. Production never sets this.
   * `disableScheduler: true` implies `disableLockfile: true` since
   * test harnesses set the former and never want the lockfile either.
   */
  disableLockfile?: boolean;
}

export function startHttpServer(
  rt: Runtime,
  options: StartHttpServerOptions = {},
): StartedServer {
  // Sidecar lockfile (Layer 2 of the orphan-prevention defence —
  // see `sidecar-lockfile.ts` for the full rationale + ticket
  // reference). Runs FIRST, before we bind the port: if a prior
  // sidecar is still alive on this configDir, we SIGTERM it and
  // wait so the new sidecar takes over cleanly.
  const configDir = dirname(rt.config.dbPath);
  if (!options.disableLockfile && !options.disableScheduler) {
    reapPriorAndLock(configDir);
  }

  const app = buildHttpApp({
    db: rt.handle.db,
    notes: rt.notes,
    folders: rt.folders,
    tags: rt.tags,
    revisions: rt.revisions,
    attachments: rt.attachments,
    comments: rt.comments,
    search: rt.search,
    indexer: rt.indexer,
    embeddings: rt.embeddings,
    audit: rt.audit,
    settings: rt.settings,
    concierge: rt.concierge,
    // Sibling-of-DB layout: `<configDir>/morion.db` and
    // `<configDir>/attachments/<ulid>.<ext>`. Derived from dbPath so
    // dev / prod / tests share the same anchor without a second env
    // lookup.
    configDir,
  });

  const onReady =
    options.onReady ??
    ((info) => {
      console.log(`morion HTTP listening on http://${info.address}:${info.port}`);
      console.log(`  db: ${rt.config.dbPath}`);
      console.log(`  vec extension loaded: ${rt.handle.hasVec}`);
      console.log(
        `  embeddings: ${rt.config.embeddings.provider} (${rt.config.embeddings.model})`,
      );
    });

  const server = serve(
    { fetch: app.fetch, hostname: rt.config.httpHost, port: rt.config.httpPort },
    onReady,
  );

  // @hono/node-server returns a type-opaque server object. setupWalWatcher
  // needs Node's http.Server to attach the WebSocketServer. The historical
  // `server as any` is preserved here rather than sprinkled at every call
  // site — one cast, documented, in one file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { wss, watcher } = setupWalWatcher(server as any, rt.config.dbPath);
  if (watcher) {
    console.log('  live sync: WAL watcher active');
  } else {
    console.log('  live sync: disabled (fallback to manual refresh)');
  }

  // Construct + start the Concierge scheduler.
  //
  // Two background workloads remain after the autonomous Mo agent was
  // deleted (ticket `01KQVA65TJ2VCY8VCKH9N5F6W8`, 2026-05-05):
  //   1. Mo Indexing tick — Tier 1 metadata + catalog/cluster regen.
  //   2. Topic-cleanup poll — proposer + auto-apply / Ask Mo escalation.
  //
  // Neither moves kanban tickets, opens chat sessions, or otherwise
  // mutates user-facing workspace state on its own. The provider
  // resolvers below are re-evaluated on every tick so a settings flip
  // (new key, backend switch) takes effect without restarting the
  // server.
  const host: ConciergeDepsHost = {
    db: rt.handle.db,
    notes: rt.notes,
    folders: rt.folders,
    comments: rt.comments,
    settings: rt.settings,
    concierge: rt.concierge,
    // Phase 2 metadata vector pipeline. The runtime always wires both;
    // when sqlite-vec / the embedder are unavailable they degrade to
    // no-op internally, so the indexing deps factory doesn't need
    // separate code paths.
    embeddings: rt.embeddings,
  };
  let scheduler: ConciergeScheduler | null = null;
  if (!options.disableScheduler) {
    // Auto-code startup work + scheduler tick callbacks live behind the
    // optional `autoCodeSchedulerWiring` seam (see
    // `features/auto-code-scheduler/`). MASTER binds the real wiring;
    // the public OSS export swaps in a `null` stub so the scheduler
    // runs Mo-indexing + topic-hygiene only. Every call is `?.`-guarded
    // so an absent wiring is a no-op.
    //
    //   1. Stale-run recovery — heal workflow_runs left pending/running
    //      by a crashed prior sidecar.
    //   2. Orphan-worktree sweep — fire-and-forget cleanup (does not
    //      block startup).
    autoCodeSchedulerWiring?.recoverStaleRuns(rt);
    autoCodeSchedulerWiring?.sweepOrphanWorktrees(rt);
    const autoCodeHooks = autoCodeSchedulerWiring?.buildSchedulerHooks(
      rt,
      configDir,
    );

    scheduler = new ConciergeScheduler({
      pollIntervalMs: options.schedulerPollIntervalMs,
      // Mo Indexing Redesign Phase 2c — Tier 1 metadata tick.
      indexingDeps: () => buildMoIndexingDeps(host),
      // Topic-cleanup periodic poll (per-folder cooldown 4h, scheduler
      // check 1h). null when the indexing bag isn't wired (test paths).
      runTopicHygienePoll: buildTopicHygienePoll(host) ?? undefined,
      // Auto-code ticks — undefined in the public build (no wiring), so
      // the scheduler skips them via its own null-guards.
      runAutoCodeEnqueueTick: autoCodeHooks?.runAutoCodeEnqueueTick,
      runAutoCodeStartupSweep: autoCodeHooks?.runAutoCodeStartupSweep,
    });
    scheduler.start();
    console.log(
      autoCodeHooks
        ? '  scheduler: Mo indexing + topic-cleanup + auto-code enqueue active'
        : '  scheduler: Mo indexing + topic-cleanup active',
    );
  } else {
    console.log('  scheduler: disabled (test harness)');
  }

  let shut = false;
  const shutdown = async (): Promise<void> => {
    if (shut) return;
    shut = true;
    // Stop the scheduler FIRST so any inflight tick or brief digest
    // can finish its transaction before we close the DB handle. The
    // scheduler's stop() awaits every promise tracked in `inflight`.
    if (scheduler) {
      try {
        await scheduler.stop();
      } catch (err) {
        console.error('scheduler stop failed:', (err as Error).message);
      }
    }
    try {
      watcher?.close();
    } catch {
      // watcher already closed or was null — fine
    }
    try {
      wss.close();
    } catch {
      // ws server already closed — fine
    }
    try {
      rt.handle.db.close();
    } catch (err) {
      console.error('db close failed:', (err as Error).message);
    }
    // Release sidecar lockfile last — only after every other cleanup
    // succeeded. If we crashed mid-shutdown, the `process.on('exit')`
    // hook in `reapPriorAndLock` is the last-resort cleanup.
    if (!options.disableLockfile && !options.disableScheduler) {
      releaseLock(configDir);
    }
  };

  return { server, watcher, wss, scheduler, shutdown };
}

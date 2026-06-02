import type { MoIndexingTickDeps } from './mo-indexing-tick.js';
import { runMoIndexingTick } from './mo-indexing-tick.js';

/**
 * Concierge scheduler — internal background tick driver.
 *
 * A single long-lived timer that polls every `POLL_INTERVAL_MS` and
 * fires two internal infrastructure workloads:
 *   1. Mo Indexing tick (Tier 1 metadata + catalog/cluster regen) —
 *      runs at most once per `indexingIntervalMs` (60s default).
 *   2. Topic-cleanup poll — runs at most once per
 *      `topicHygieneCheckIntervalMs` (1h default).
 *
 * The autonomous per-folder Mo agent that used to drive kanban /
 * proactive notifications based on each folder's workflow text was
 * removed 2026-05-03 — the scheduler no longer reads
 * `concierge.schedule_mode` / `concierge.schedule_minutes` and no
 * longer iterates `conciergeSettings.listEnabled()`. Folder-level Mo
 * work happens only via explicit user actions (Ask Mo chat,
 * `mo_record`, `mo_remember`, manual indexing tick HTTP route).
 *
 * Graceful shutdown: callers invoke `.stop()` from SIGTERM so in-flight
 * indexing/cleanup passes finish before the process exits. WAL +
 * SQLite writes settle naturally once the timer is cleared and all
 * pending promises resolve.
 */

const POLL_INTERVAL_MS = 30_000;
const MO_INDEXING_TICK_INTERVAL_MS = 60_000;

export interface ConciergeSchedulerOptions {
  /** Override poll interval — tests run at sub-second cadence. */
  pollIntervalMs?: number;
  /** Optional structured logger; defaults to console.* for low-volume
   * visibility. Scheduler logs ONLY state changes (tick start/end,
   * skip reasons) — the transcript lives in `concierge_messages`. */
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Clock injection for tests. */
  now?: () => number;
  /**
   * Mo Indexing Redesign Phase 2c — getter for the indexing tick's
   * deps. When provided, the scheduler runs `runMoIndexingTick` once
   * every `MO_INDEXING_TICK_INTERVAL_MS` (60s by default) to drive
   * Tier 1 metadata computation off `audit_log` events. Skipped
   * entirely if absent (back-compat for tests + the legacy server
   * paths that haven't wired indexing yet). Getter form lets the
   * OpenRouter key + backend toggle take effect on the next tick
   * without restarting the scheduler.
   *
   * Phase 4 cutover (2026-04-27): replaces the legacy
   * `runBriefDigest` path entirely. The brief → catalog migration
   * means Mo Workflow ticks now read the freshly-maintained
   * `mo:catalog` note instead of `folder_briefs.body`.
   */
  indexingDeps?: MoIndexingTickDeps | (() => MoIndexingTickDeps);
  /** Override indexing-tick min-interval for tests. Default 60s. */
  indexingIntervalMs?: number;
  /**
   * Topic-cleanup poll. When set, the scheduler invokes this callback
   * once per `topicHygieneIntervalMs` (defaults to 1h). The callback's
   * own per-folder cooldown (`pollTopicHygieneAcrossFolders`'s
   * `intervalMs`, default 4h) decides which folders actually run.
   * Two-tier cooldown deliberately: scheduler-tier rate-limits how
   * often we even check; per-folder tier rate-limits how often we
   * spend LLM tokens on a folder. Production wiring lives in
   * `concierge-deps.ts`.
   */
  runTopicHygienePoll?: () => Promise<void>;
  /** Default 1h — the scheduler-tier check cadence. */
  topicHygieneCheckIntervalMs?: number;
  /**
   * Auto-code enqueue tick (umbrella `01KR5F21709BKA6SFHWRFFVVPY`,
   * L2.T7.B.2.d). When set, the scheduler invokes this once per
   * poll to drain `audit_log` rows where `status_to='todo'` for
   * auto-code-enabled folders. Catches all trigger paths the
   * legacy kanban-move HTTP route missed (programmatic moves,
   * note-create-with-status='todo', pre-existing tickets).
   * Cheap (SQL + dispatcher dedupe); no per-tick cooldown.
   */
  runAutoCodeEnqueueTick?: () => Promise<void>;
  /**
   * Auto-code startup sweep — full scan for pre-existing `todo`
   * tickets in auto-code-enabled folders that have no active run.
   * Runs ONCE at scheduler start (gated by a workspace setting
   * inside the callback). Idempotent; safe to invoke unconditionally.
   */
  runAutoCodeStartupSweep?: () => Promise<void>;
  /**
   * Workflow schedules tick (Scheduler epic 01KSX1WJF0TR6949TDQS7Z1TXS,
   * Phase 1c). When set, the scheduler invokes this once per poll to
   * pull cron-due schedules and dispatch them. The callback owns the
   * full list-due → dispatch → markFired flow; this option is just
   * the wiring. Same inflight-guard shape as the other ticks — never
   * re-entrant within one in-flight tick.
   *
   * The actual workflow dispatch (Phase 1d) plugs in via the tick
   * factory's `dispatch` dep; the scheduler only knows about this
   * 0-arg async callback. Skipped entirely when absent (back-compat
   * for tests + the OSS public build that doesn't ship the scheduler).
   */
  runWorkflowSchedulesTick?: () => Promise<void>;
}

export class ConciergeScheduler {
  private timer: NodeJS.Timeout | null = null;
  /**
   * Track the promise for every inflight tick so `stop()` can wait
   * for them to settle under SIGTERM instead of returning after one
   * event-loop yield (which was the bug — process.exit() could fire
   * mid-transaction, leaving WAL partial).
   */
  private inflight = new Set<Promise<void>>();
  private readonly pollInterval: number;
  private readonly log: NonNullable<ConciergeSchedulerOptions['log']>;
  private readonly now: () => number;
  private readonly resolveIndexingDeps: (() => MoIndexingTickDeps) | null;
  private readonly indexingIntervalMs: number;
  private lastIndexingTickAt = 0;
  private indexingInflight: Promise<void> | null = null;
  private readonly runTopicHygienePoll: (() => Promise<void>) | null;
  private readonly topicHygieneCheckIntervalMs: number;
  private lastTopicHygieneCheckAt = 0;
  private topicHygieneInflight: Promise<void> | null = null;
  private readonly runAutoCodeEnqueueTickFn: (() => Promise<void>) | null;
  private autoCodeEnqueueInflight: Promise<void> | null = null;
  /** Per-folder sweep markers live in the workspace settings table
   *  (see `AUTO_CODE_FOLDER_SWEEP_DONE_KEY_PREFIX`); the scheduler
   *  itself fires the sweep on every poll. The callback's per-folder
   *  marker check makes the SQL effectively a no-op once each
   *  folder is done. */
  private readonly runAutoCodeStartupSweepFn: (() => Promise<void>) | null;
  private autoCodeStartupSweepInflight: Promise<void> | null = null;
  private readonly runWorkflowSchedulesTickFn: (() => Promise<void>) | null;
  private workflowSchedulesInflight: Promise<void> | null = null;

  constructor(opts: ConciergeSchedulerOptions = {}) {
    this.pollInterval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.log = opts.log ?? {
      info: (m, meta) => console.log(`[concierge] ${m}`, meta ?? ''),
      warn: (m, meta) => console.warn(`[concierge] ${m}`, meta ?? ''),
      error: (m, meta) => console.error(`[concierge] ${m}`, meta ?? ''),
    };
    this.now = opts.now ?? (() => Date.now());
    const i = opts.indexingDeps;
    this.resolveIndexingDeps = i == null
      ? null
      : typeof i === 'function'
        ? (i as () => MoIndexingTickDeps)
        : () => i;
    this.indexingIntervalMs =
      opts.indexingIntervalMs ?? MO_INDEXING_TICK_INTERVAL_MS;
    this.runTopicHygienePoll = opts.runTopicHygienePoll ?? null;
    this.topicHygieneCheckIntervalMs =
      opts.topicHygieneCheckIntervalMs ?? 60 * 60 * 1000;
    this.runAutoCodeEnqueueTickFn = opts.runAutoCodeEnqueueTick ?? null;
    this.runAutoCodeStartupSweepFn = opts.runAutoCodeStartupSweep ?? null;
    this.runWorkflowSchedulesTickFn = opts.runWorkflowSchedulesTick ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.log.info('scheduler started', { pollIntervalMs: this.pollInterval });
    // Fire once immediately so a freshly-enabled folder doesn't wait a
    // full poll interval for its first tick.
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollInterval);
    // `unref` so the scheduler doesn't keep the Node event loop alive
    // on its own — SIGTERM + shutdown should still trigger process exit.
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.log.info('scheduler stopping — waiting for in-flight ticks', {
      inFlight: this.inflight.size,
    });
    // Actually wait for every inflight tick + indexing pass to settle.
    // Any one of them may be mid-transaction (notes.moveToKanban,
    // comments.create, mo:catalog upsert); interrupting would leave
    // WAL partial and next startup would see a half-applied row. The
    // Node SIGTERM handler that calls stop() is the only thing
    // keeping the process alive — once this resolves it's safe to
    // close the DB handle + exit.
    await Promise.allSettled([...this.inflight]);
    this.log.info('scheduler stopped', { inFlight: this.inflight.size });
  }

  /**
   * Single poll pass. Public so tests + manual recovery can force one.
   * Safe to call concurrently — internal inflight flags drop duplicates.
   *
   * Two background workloads remain:
   *   1. Mo Indexing tick (Tier 1 metadata, catalog/cluster regen) —
   *      internal infrastructure, runs unconditionally so notes always
   *      have summary + keywords + cluster assignments regardless of
   *      user-facing settings.
   *   2. Topic-cleanup poll — same shape, internal hygiene.
   *
   * The autonomous per-folder Mo agent ("Mo runs the kanban based on
   * each folder's workflow text") was removed 2026-05-03 — see commit
   * message for the user request and rationale. Folder-level Mo work
   * now happens only via explicit user actions (Ask Mo chat,
   * `mo_record`, `mo_remember`, manual indexing tick). The
   * `concierge.schedule_mode` / `concierge.schedule_minutes`
   * workspace settings + the `concierge_folder_settings.schedule_*`
   * columns stay in the DB for back-compat but are no longer read.
   */
  async poll(): Promise<void> {
    const now = this.now();

    // Mo Indexing Redesign Phase 2c — periodic Tier 1 metadata tick.
    // Runs at most once per `indexingIntervalMs`, never re-entrant
    // (the inflight guard skips overlapping invocations rather than
    // queueing). Skipped entirely when `resolveIndexingDeps` is null
    // (legacy startup paths that haven't wired indexing yet).
    //
    // CRITICAL: indexing must run regardless of `workspaceMode`. The
    // mode flag controls the AUTONOMOUS Mo agent (kanban patrol —
    // user-visible "Mo is doing things" surface) which the user
    // legitimately wants to throttle to manual. The indexing pipeline
    // (metadata generation, catalog/cluster regen, bootstrap sweep)
    // is INTERNAL infrastructure that keeps the index consistent with
    // notes — gating it on the user's autonomous-Mo preference would
    // mean ghost notes never get summarised on a `manual` workspace.
    // This block lives ABOVE the `manual → return` guard for that
    // exact reason. (1.3.0 shipped with this block below the guard;
    // bug surfaced when user on manual schedule saw 144 user notes
    // never get metadata after 1.3.0 install.)
    if (
      this.resolveIndexingDeps &&
      !this.indexingInflight &&
      now - this.lastIndexingTickAt >= this.indexingIntervalMs
    ) {
      this.lastIndexingTickAt = now;
      const deps = this.resolveIndexingDeps();
      const indexingPromise = (async () => {
        try {
          const summary = await runMoIndexingTick(deps);
          if (summary.status === 'ok') {
            this.log.info('mo indexing tick ok', {
              enqueued: summary.enqueued,
              checkpoint: summary.newCheckpoint,
              computed: summary.worker?.computed ?? 0,
              fresh: summary.worker?.fresh ?? 0,
              errors: summary.worker?.errors ?? 0,
              abandoned: summary.worker?.abandoned ?? 0,
            });
          }
        } catch (err) {
          this.log.warn('mo indexing tick threw', {
            error: (err as Error).message,
          });
        }
      })();
      const tracked = indexingPromise.finally(() => {
        this.indexingInflight = null;
        this.inflight.delete(tracked);
      });
      this.indexingInflight = tracked;
      this.inflight.add(tracked);
      void tracked;
    }

    // Topic-cleanup poll. Two-tier cooldown: this scheduler-tier
    // check fires at most once per `topicHygieneCheckIntervalMs`
    // (default 1h); the callback's own per-folder cooldown
    // (`pollTopicHygieneAcrossFolders`'s `intervalMs`, default 4h)
    // decides which folders actually run. Lives ABOVE the
    // `manual → return` guard for the same reason as indexing —
    // topic cleanup is internal infrastructure that benefits the
    // user even when their Mo schedule is manual.
    if (
      this.runTopicHygienePoll &&
      !this.topicHygieneInflight &&
      now - this.lastTopicHygieneCheckAt >= this.topicHygieneCheckIntervalMs
    ) {
      this.lastTopicHygieneCheckAt = now;
      const cleanupPromise = (async () => {
        try {
          await this.runTopicHygienePoll!();
        } catch (err) {
          this.log.warn('topic hygiene poll threw', {
            error: (err as Error).message,
          });
        }
      })();
      const trackedClean = cleanupPromise.finally(() => {
        this.topicHygieneInflight = null;
        this.inflight.delete(trackedClean);
      });
      this.topicHygieneInflight = trackedClean;
      this.inflight.add(trackedClean);
      void trackedClean;
    }

    // Auto-code per-folder sweep — fires every poll. The callback
    // skips folders whose marker is set (cheap settings.get per
    // folder), so sustained load is one SQL pass + N settings reads.
    // Newly-enabled folders get scanned on the next poll, which
    // closes the P1.1 gap where workspace-wide marker locked out
    // post-first-sweep enables.
    if (
      this.runAutoCodeStartupSweepFn &&
      !this.autoCodeStartupSweepInflight
    ) {
      const sweepPromise = (async () => {
        try {
          await this.runAutoCodeStartupSweepFn!();
        } catch (err) {
          this.log.warn('auto-code startup sweep threw', {
            error: (err as Error).message,
          });
        }
      })();
      const trackedSweep = sweepPromise.finally(() => {
        this.autoCodeStartupSweepInflight = null;
        this.inflight.delete(trackedSweep);
      });
      this.autoCodeStartupSweepInflight = trackedSweep;
      this.inflight.add(trackedSweep);
      void trackedSweep;
    }

    // Auto-code enqueue tick — incremental drain of `audit_log`
    // status_change rows where `status_to='todo'`. Cheap (SQL +
    // dispatcher dedupe); fires every poll. Skipped while a prior
    // tick is still in flight (atomic admission collapses the
    // overlap anyway, but we don't waste a SQL pass).
    if (this.runAutoCodeEnqueueTickFn && !this.autoCodeEnqueueInflight) {
      const enqueuePromise = (async () => {
        try {
          await this.runAutoCodeEnqueueTickFn!();
        } catch (err) {
          this.log.warn('auto-code enqueue tick threw', {
            error: (err as Error).message,
          });
        }
      })();
      const trackedEnqueue = enqueuePromise.finally(() => {
        this.autoCodeEnqueueInflight = null;
        this.inflight.delete(trackedEnqueue);
      });
      this.autoCodeEnqueueInflight = trackedEnqueue;
      this.inflight.add(trackedEnqueue);
      void trackedEnqueue;
    }

    // Workflow schedules tick — pull cron-due rows and dispatch them.
    // Fires every poll (the tick itself is cheap when nothing's due:
    // one indexed SELECT + JS filter). Same inflight-guard semantics
    // as the other ticks. Skipped entirely when the callback isn't
    // wired (OSS public build, test setups that disable scheduling).
    // Production wiring lives in `auto-code-scheduler` feature dir;
    // see `buildWorkflowSchedulesTick` in
    // `src/core/auto-code/schedules/tick.ts` for the factory.
    if (
      this.runWorkflowSchedulesTickFn &&
      !this.workflowSchedulesInflight
    ) {
      const schedulesPromise = (async () => {
        try {
          await this.runWorkflowSchedulesTickFn!();
        } catch (err) {
          this.log.warn('workflow schedules tick threw', {
            error: (err as Error).message,
          });
        }
      })();
      const trackedSchedules = schedulesPromise.finally(() => {
        this.workflowSchedulesInflight = null;
        this.inflight.delete(trackedSchedules);
      });
      this.workflowSchedulesInflight = trackedSchedules;
      this.inflight.add(trackedSchedules);
      void trackedSchedules;
    }
  }
}

/**
 * Scheduler tick callback for cron-triggered workflow runs.
 *
 * Phase 1c of the Scheduler epic (ticket 01KSX1WJF0TR6949TDQS7Z1TXS).
 * Pure async function — pulls due schedules, calls a caller-supplied
 * dispatch handler for each, stamps `last_run_at` + `last_run_status`.
 *
 * Phase 1c does NOT implement the actual WorkflowRunner dispatch —
 * that's Phase 1d (requires `workflow_runs.ticket_id` to be nullable
 * + a new `dispatchScheduled()` entry point on the runner). The
 * `dispatch` dep is the seam: Phase 1d will plug in the real handler,
 * tests + production bootstrap can plug in stubs / no-ops in the meantime.
 *
 * Wired into ConciergeScheduler.poll() via the `runWorkflowSchedulesTick`
 * option. The scheduler's existing inflight-guard pattern ensures
 * overlapping polls collapse to a single in-flight tick.
 */
import type {
  WorkflowSchedulesRepository,
  WorkflowSchedule,
  ScheduleLastRunStatus,
} from './repository.js';

export interface WorkflowSchedulesTickDeps {
  /** Repository handle — `listDue` + `markFired` are the only methods used. */
  repo: WorkflowSchedulesRepository;
  /**
   * Dispatch a single due schedule into the WorkflowRunner. Resolved
   * when the run is enqueued (NOT when it finishes — dispatch is fire-
   * and-forget from the tick's perspective; the runner owns the
   * downstream state machine). Rejection signals "we couldn't even
   * start this one" — tick marks the schedule `failed` so the user
   * can investigate via Phase 2 UI.
   *
   * Phase 1c uses a stub (no-op). Phase 1d swaps in the real call:
   *   `(s) => workflowRunner.dispatchScheduled({scheduleId: s.id, workflowId: s.workflowId, folderId: s.folderId})`.
   */
  dispatch: (schedule: WorkflowSchedule) => Promise<void>;
  /** Clock injection for tests. */
  now?: () => Date;
  /**
   * Structured logger. Same shape as ConciergeScheduler's. Optional;
   * defaults to console.* for low-volume visibility.
   */
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface WorkflowSchedulesTickSummary {
  /** Number of schedules that matched cron at this poll. */
  dueCount: number;
  /** Number that dispatched successfully and were marked 'pending'. */
  fired: number;
  /** Number whose dispatch handler rejected — marked 'failed'. */
  failed: number;
}

/**
 * Build the per-poll tick callback. Returns a 0-arg async function the
 * ConciergeScheduler can call directly. The returned function is
 * idempotent within a single minute thanks to `listDue`'s same-minute
 * skip — repeated calls during a 30s-poll-interval inside the same
 * 60s cron-minute will fire each schedule exactly once.
 *
 * Wrapped in a factory so production wiring (bootstrap/start.ts) and
 * tests share the same construction shape. Mirrors the
 * `runMoIndexingTick` / `runAutoCodeEnqueueTick` patterns.
 */
export function buildWorkflowSchedulesTick(
  deps: WorkflowSchedulesTickDeps,
): () => Promise<WorkflowSchedulesTickSummary> {
  const log = deps.log ?? {
    info: (m, meta) => console.log(`[scheduler-tick] ${m}`, meta ?? ''),
    warn: (m, meta) => console.warn(`[scheduler-tick] ${m}`, meta ?? ''),
  };
  const clock = deps.now ?? (() => new Date());

  return async function runWorkflowSchedulesTick(): Promise<WorkflowSchedulesTickSummary> {
    const now = clock();
    const due = deps.repo.listDue(now);
    if (due.length === 0) {
      return { dueCount: 0, fired: 0, failed: 0 };
    }

    log.info('scheduler tick: due schedules', {
      count: due.length,
      ids: due.map((s) => s.id),
    });

    let fired = 0;
    let failed = 0;
    const firedAt = now.getTime();

    // Sequential dispatch — overlapping the same WorkflowRunner with
    // N parallel starts in a 60s cron window is fine (the runner has
    // its own concurrency), but sequential keeps log ordering sane
    // and bounds the worst-case "stuck dispatch" blast radius to one
    // schedule at a time. If we ever need parallelism, swap to
    // Promise.allSettled — listDue already deduplicates against
    // last_run_at so reentry within the minute is safe.
    for (const schedule of due) {
      let status: ScheduleLastRunStatus = 'pending';
      try {
        await deps.dispatch(schedule);
        fired++;
      } catch (err) {
        status = 'failed';
        failed++;
        log.warn('scheduler tick: dispatch threw', {
          scheduleId: schedule.id,
          folderId: schedule.folderId,
          workflowId: schedule.workflowId,
          error: (err as Error).message,
        });
      }
      // Stamp last_run_at + status BEFORE the next iteration so a
      // crash mid-loop doesn't replay the already-fired schedules
      // on the next tick. listDue's same-minute guard depends on
      // last_run_at being current.
      deps.repo.markFired(schedule.id, status, firedAt);
    }

    return { dueCount: due.length, fired, failed };
  };
}

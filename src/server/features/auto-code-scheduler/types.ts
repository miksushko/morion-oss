import type { Runtime } from '../../../core/runtime.js';

/**
 * Contract for the auto-code scheduler wiring. Lives in its own file so
 * BOTH the master impl (`index.ts`) and the public stub (`index.public.ts`,
 * swapped to index.ts at export) can import it — `types.ts` ships to the
 * public OSS export, the master `index.ts` does not.
 */
export interface AutoCodeSchedulerHooks {
  runAutoCodeEnqueueTick: () => Promise<void>;
  runAutoCodeStartupSweep: () => Promise<void>;
}

export interface AutoCodeSchedulerWiring {
  /**
   * Heal workflow_runs rows a previous sidecar left in `pending` /
   * `running` / `paused_ask_user` (crash, force-quit, OS sleep-wake, or
   * a dispatch path that threw between row claim and dispatchExisting).
   * Without this, the next enqueue's `findActiveRunForTicket` dedupes
   * against the stuck row and returns `{deduped: true}` → user sees
   * nothing happen for what they thought was a fresh drag. Mirrors
   * `WorkflowRunner.recoverStaleRuns()` but runs at startup. Synchronous.
   */
  recoverStaleRuns(rt: Runtime): void;
  /**
   * Orphan-worktree sweep (ticket 01KRFX0PNE4WAFTDYJ3FQPK8F7) — walks
   * every linked repo's `.morion/worktrees/` AND `.claude/worktrees/`
   * (legacy) and drops any `auto-<ulid>` worktree with no active row /
   * a terminal row. Fire-and-forget; does NOT block startup.
   */
  sweepOrphanWorktrees(rt: Runtime): void;
  /** Build the two auto-code scheduler tick callbacks. */
  buildSchedulerHooks(rt: Runtime, configDir: string): AutoCodeSchedulerHooks;
}

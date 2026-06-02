import {
  AgentQueueRepository,
  type AgentQueueRow,
} from './queue.js';
import { removeWorktree } from './worktree-paths.js';

/**
 * Auto-code Phase 2 — toggle-off process killer
 * (sub-ticket 01KQEED9ARX0QZ25S775WDBQC1, umbrella
 * 01KQANTZDKW6QH461AK2JN3DCQ).
 *
 * When the user disables `auto_code_enabled` for a folder, every
 * in-flight ticket needs to stop within seconds — not "after the
 * 30-min wall-clock timeout fires". This module is the killer:
 *
 *   1. List all in-flight rows for the folder via the queue.
 *   2. For each row with `active_pid`, SIGTERM the process. If it
 *      doesn't exit within `killAfterTermMs` (default 5s),
 *      escalate to SIGKILL.
 *   3. Mark every in-flight row `cancelled` via the queue's
 *      `cancelAllInFlightForFolder` (atomic state transition).
 *   4. Sweep each row's worktree via `removeWorktree` — failure to
 *      remove is non-fatal (the orchestrator's app-startup cleanup
 *      will retry via `listOrphanWorktrees`).
 *
 * The killer is independent of the orchestrator (#6). The HTTP
 * route layer wraps the existing PUT-settings handler: on
 * `enabled: true → false` transition for a folder, call
 * `cancelInFlightForFolder(folderId, deps)` BEFORE returning the
 * updated settings, so the user's PATCH response carries the
 * cancellation summary.
 *
 * The UI popup gate (count > 0 → confirmation modal) lives in the
 * web layer and uses the read-only `inFlightSummary` helper from
 * this module.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InFlightSummary {
  /** Number of in-flight (non-terminal) rows for the folder. */
  count: number;
  /** Task titles for the UI popup ("3 tickets are running:\n - X\n
   *  - Y\n - Z"). Empty when count = 0. */
  taskTitles: string[];
}

export interface CancelSummary {
  /** Cancelled row count. */
  cancelledCount: number;
  /** PIDs we sent SIGTERM to. */
  signaledPids: number[];
  /** PIDs we had to SIGKILL after the SIGTERM grace window. */
  forceKilledPids: number[];
  /** Worktrees we attempted to remove. */
  worktreesRemoved: number;
  /** Worktrees that errored on removal (non-fatal — caller logs). */
  worktreeRemovalErrors: Array<{ worktreeName: string; error: string }>;
}

export interface CancelDeps {
  queue: AgentQueueRepository;
  /** Linked repo path for this folder — needed for worktree cleanup. */
  repoPath: string;
  /** Override the default 5s SIGTERM → SIGKILL grace window. */
  killAfterTermMs?: number;
  /** Inject for tests so we don't actually signal real PIDs. */
  killProcess?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  /** Inject for tests — replaces `removeWorktree`. */
  removeWorktreeImpl?: (
    repoPath: string,
    worktreeName: string,
  ) => Promise<{ worktreeRemoved: boolean; branchRemoved: boolean; error: string | null }>;
  /** Override the post-SIGTERM "is the process alive?" probe. */
  isProcessAlive?: (pid: number) => boolean;
}

const DEFAULT_KILL_AFTER_TERM_MS = 5_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read-only summary of in-flight rows for the folder. Powers the
 * UI's pre-toggle-off popup.
 */
export function inFlightSummary(
  queue: AgentQueueRepository,
  folderId: string,
  notesById: (taskId: string) => { title: string } | null,
): InFlightSummary {
  const rows = queue.listInFlightForFolder(folderId);
  const taskTitles: string[] = [];
  for (const r of rows) {
    const note = notesById(r.taskId);
    taskTitles.push(note?.title ?? r.taskId);
  }
  return { count: rows.length, taskTitles };
}

/**
 * Cancel every in-flight row for the folder + tear down its
 * processes + worktrees. Pure side-effect function; returns a
 * summary the route can echo back in its PATCH response.
 *
 * Idempotent — calling twice on the same folder leaves it the same
 * (second call sees no in-flight rows + no-ops cleanly). Safe to
 * call when there's nothing to cancel.
 */
export async function cancelInFlightForFolder(
  folderId: string,
  deps: CancelDeps,
): Promise<CancelSummary> {
  const killAfterTermMs = deps.killAfterTermMs ?? DEFAULT_KILL_AFTER_TERM_MS;
  const killProcess = deps.killProcess ?? defaultKillProcess;
  const removeImpl = deps.removeWorktreeImpl ?? removeWorktree;
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;

  // Snapshot in-flight rows BEFORE cancelling — once
  // `cancelAllInFlightForFolder` runs, the queue's `active_pid` /
  // `worktree_name` columns are wiped on terminal transition.
  const inFlight = deps.queue.listInFlightForFolder(folderId);
  const summary: CancelSummary = {
    cancelledCount: 0,
    signaledPids: [],
    forceKilledPids: [],
    worktreesRemoved: 0,
    worktreeRemovalErrors: [],
  };

  // 1. SIGTERM every active PID. Done BEFORE the queue transition
  //    so a row's `active_pid` is still readable. Termination is
  //    best-effort; orphan PIDs (process already gone) are silently
  //    swallowed by the killer.
  const pidGroups: Array<{ row: AgentQueueRow; pid: number }> = [];
  for (const row of inFlight) {
    if (row.activePid && row.activePid > 0) {
      try {
        killProcess(row.activePid, 'SIGTERM');
        summary.signaledPids.push(row.activePid);
      } catch {
        // Process already exited / wrong owner — ignore.
      }
      pidGroups.push({ row, pid: row.activePid });
    }
  }

  // 2. Atomically transition rows to `cancelled`. The queue clears
  //    `claimed_at` + `active_pid` as part of the terminal write
  //    so a fresh app start finds no half-claimed rows.
  const cancelled = deps.queue.cancelAllInFlightForFolder(folderId, 'toggle-off');
  summary.cancelledCount = cancelled.length;

  // 3. Wait for SIGTERM to land, then SIGKILL anything still alive.
  //    Done in PARALLEL across PIDs so the worst case is one grace
  //    window, not N × grace.
  if (pidGroups.length > 0) {
    await new Promise((r) => setTimeout(r, killAfterTermMs));
    for (const { pid } of pidGroups) {
      if (isAlive(pid)) {
        try {
          killProcess(pid, 'SIGKILL');
          summary.forceKilledPids.push(pid);
        } catch {
          // Already gone in the meantime.
        }
      }
    }
  }

  // 4. Worktree cleanup — best-effort, errors collected for the
  //    activity surface but never thrown.
  for (const row of inFlight) {
    if (!row.worktreeName) continue;
    try {
      const result = await removeImpl(deps.repoPath, row.worktreeName);
      if (result.worktreeRemoved) summary.worktreesRemoved++;
      if (result.error) {
        summary.worktreeRemovalErrors.push({
          worktreeName: row.worktreeName,
          error: result.error,
        });
      }
    } catch (e) {
      summary.worktreeRemovalErrors.push({
        worktreeName: row.worktreeName,
        error: (e as Error).message ?? String(e),
      });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Defaults — overridable for tests
// ---------------------------------------------------------------------------

function defaultKillProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  process.kill(pid, signal);
}

/**
 * Per-task cancellation — used when the user manually drags a kanban
 * card OUT of the agent's working state (e.g. drag from `doing`
 * back to `backlog` while a fix-session is mid-run). Same SIGTERM →
 * SIGKILL → state transition → worktree cleanup pattern as
 * `cancelInFlightForFolder`, scoped to one row.
 *
 * Returns null when the task has no in-flight row (already done /
 * never enqueued). Returns a single-row CancelSummary on cancel.
 *
 * The route layer in `kanban.ts` calls this AFTER the kanban-move
 * lands, so the queue cancel doesn't race with the user's intent.
 * The state transition uses the queue's atomic
 * `cancelAllInFlightForFolder` filtered by the matching row id —
 * see #5 below.
 */
export async function cancelInFlightForTask(
  folderId: string,
  taskId: string,
  deps: CancelDeps & { reason?: string },
): Promise<CancelSummary | null> {
  const row = deps.queue.getInFlightForTask(folderId, taskId);
  if (!row) return null;

  const killAfterTermMs = deps.killAfterTermMs ?? DEFAULT_KILL_AFTER_TERM_MS;
  const killProcess = deps.killProcess ?? defaultKillProcess;
  const removeImpl = deps.removeWorktreeImpl ?? removeWorktreeDefault;
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const reason = deps.reason ?? 'kanban-move';

  const summary: CancelSummary = {
    cancelledCount: 0,
    signaledPids: [],
    forceKilledPids: [],
    worktreesRemoved: 0,
    worktreeRemovalErrors: [],
  };

  // 1. SIGTERM the active PID if any.
  if (row.activePid && row.activePid > 0) {
    try {
      killProcess(row.activePid, 'SIGTERM');
      summary.signaledPids.push(row.activePid);
    } catch {
      /* process gone */
    }
  }

  // 2. Atomic state transition. We use the queue's per-row
  //    `transition` instead of cancelAllInFlightForFolder since we
  //    only want THIS row, not every in-flight row in the folder.
  const next = deps.queue.transition(row.id, row.state, 'cancelled', {
    lastError: reason,
  });
  if (next) summary.cancelledCount = 1;

  // 3. SIGKILL if the process ignored SIGTERM.
  if (row.activePid && row.activePid > 0) {
    await new Promise((r) => setTimeout(r, killAfterTermMs));
    if (isAlive(row.activePid)) {
      try {
        killProcess(row.activePid, 'SIGKILL');
        summary.forceKilledPids.push(row.activePid);
      } catch {
        /* gone in the meantime */
      }
    }
  }

  // 4. Worktree cleanup.
  if (row.worktreeName) {
    try {
      const r = await removeImpl(deps.repoPath, row.worktreeName);
      if (r.worktreeRemoved) summary.worktreesRemoved++;
      if (r.error) {
        summary.worktreeRemovalErrors.push({
          worktreeName: row.worktreeName,
          error: r.error,
        });
      }
    } catch (e) {
      summary.worktreeRemovalErrors.push({
        worktreeName: row.worktreeName,
        error: (e as Error).message ?? String(e),
      });
    }
  }

  return summary;
}

/**
 * Re-export the launcher's removeWorktree under a stable internal
 * name so the per-task path can default to it without re-importing
 * (the per-folder path already does the same trick via the closure
 * default in `cancelInFlightForFolder`).
 */
const removeWorktreeDefault = removeWorktree;

/**
 * Probe whether a PID is still alive. `process.kill(pid, 0)` is
 * the standard POSIX trick — sends signal 0 (no-op) which throws
 * ESRCH when the process is gone. We only treat ESRCH as "dead";
 * EPERM means the process exists but we can't signal it (different
 * UID), which counts as "alive" for our purposes.
 */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return false;
  }
}

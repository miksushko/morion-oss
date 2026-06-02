import type Database from 'better-sqlite3';
import { ulid } from 'ulid';

import {
  MAX_ATTEMPTS_BEFORE_FAILED,
  MAX_INFLIGHT_PER_FOLDER,
  TERMINAL_STATES,
  type AgentQueueRow,
  type AgentQueueState,
  type EnqueueOptions,
  type EnqueueResult,
} from './types.js';
import { rowToAgent, type Row } from './row-mapping.js';

/**
 * Auto-code durable queue repository — SQLite-backed state machine for the
 * kanban → Claude → Codex → Mo loop. Cohesive class because every method
 * shares the same `db` field + transaction context + row-mapping helpers.
 *
 * Extracted from `../queue.ts` (2026-05-16, ticket
 * `01KRQYRP1KPN25W5F4PTC7E9XJ`). The 612-LOC parent file became a barrel
 * after this move; types + row mapping live in `./types.ts` + `./row-mapping.ts`.
 *
 * Per CLAUDE.md "cohesive state machines / domain modules are exceptions" to
 * the 500-LOC cap — the class stays as-is because helper-with-this-param
 * extractions would leak private `db` access through every method signature.
 */
export class AgentQueueRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a fresh `pending` row, OR return the existing in-flight
   * row if one already covers this `(folder_id, task_id)`. Mirrors
   * the umbrella spec's "one ticket → one Mo session at a time".
   *
   * If a previous row for this task is already terminal, the partial
   * unique index lets the new INSERT succeed and we get a fresh
   * pending row (a re-run starts from scratch).
   */
  enqueue(opts: EnqueueOptions): EnqueueResult {
    const now = opts.now ?? Date.now();
    const id = ulid();
    const sessionGroupId = opts.sessionGroupId ?? id;
    try {
      this.db
        .prepare(
          `INSERT INTO mo_agent_queue (
             id, folder_id, task_id, state, attempts, reopen_count,
             repo_path, worktree_name, fix_session_id, review_session_id,
             last_verdict, last_error, active_pid, session_group_id,
             claimed_at, created_at, updated_at
           ) VALUES (?, ?, ?, 'pending', 0, 0,
                    ?, NULL, NULL, NULL,
                    NULL, NULL, NULL, ?,
                    NULL, ?, ?)`,
        )
        .run(id, opts.folderId, opts.taskId, opts.repoPath, sessionGroupId, now, now);
    } catch (err) {
      // SQLITE_CONSTRAINT — another in-flight row exists. Return it
      // so the caller can surface "already queued" without treating
      // the dedup as an error.
      const existing = this.getInFlightForTask(opts.folderId, opts.taskId);
      if (existing) return { kind: 'deduped', existing };
      throw err;
    }
    const row = this.getById(id);
    if (!row) throw new Error('agent queue: row vanished after INSERT');
    return { kind: 'inserted', row };
  }

  getById(id: string): AgentQueueRow | null {
    const row = this.db
      .prepare<[string], Row>('SELECT * FROM mo_agent_queue WHERE id = ?')
      .get(id);
    return row ? rowToAgent(row) : null;
  }

  /**
   * Find the active (non-terminal) row for a task in a folder, if any.
   * Per the partial unique index there is at most one.
   */
  getInFlightForTask(folderId: string, taskId: string): AgentQueueRow | null {
    const row = this.db
      .prepare<[string, string], Row>(
        `SELECT * FROM mo_agent_queue
          WHERE folder_id = ? AND task_id = ?
            AND state NOT IN ('done', 'cancelled', 'failed')
          LIMIT 1`,
      )
      .get(folderId, taskId);
    return row ? rowToAgent(row) : null;
  }

  /** Per-folder count toward the concurrency cap. */
  inFlightCount(folderId: string): number {
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM mo_agent_queue
          WHERE folder_id = ?
            AND state IN ('pending','fix_running','fix_review','review_running','reopened')`,
      )
      .get(folderId);
    return row?.c ?? 0;
  }

  /** Every in-flight row for a folder. Used by the toggle-off killer
   *  in #9 to enumerate work to SIGTERM and the activity surface in #10
   *  to render "Active runs" lists. */
  listInFlightForFolder(folderId: string): AgentQueueRow[] {
    return this.db
      .prepare<[string], Row>(
        `SELECT * FROM mo_agent_queue
          WHERE folder_id = ?
            AND state IN ('pending','fix_running','fix_review','review_running','reopened')
          ORDER BY created_at ASC`,
      )
      .all(folderId)
      .map(rowToAgent);
  }

  /** All rows for a task, newest first. Powers the AutoCodeDrawer's
   *  "Runs" picker so the user can flip between current + historical
   *  attempts on the same ticket. */
  listForTask(taskId: string, limit = 50): AgentQueueRow[] {
    return this.db
      .prepare<[string, number], Row>(
        `SELECT * FROM mo_agent_queue
          WHERE task_id = ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(taskId, limit)
      .map(rowToAgent);
  }

  /**
   * Latest row per task across a batch of task ids — single query,
   * no N+1. Powers the kanban-card badge surface that needs to know
   * "does this card have any auto-code activity to show?" for every
   * visible card on every render. Returns a Map keyed by task_id;
   * tasks with zero rows are simply absent from the map.
   *
   * The "latest" is by `created_at DESC` — same ordering as
   * `listForTask` — so a `done`/`failed` row from yesterday wins
   * over a fresh `pending` only if the pending IS older, which
   * never happens (pending rows have a fresh `created_at` by
   * construction). In practice the latest row is always either the
   * currently-active one OR the most recent terminal.
   */
  listLatestForTasks(taskIds: string[]): Map<string, AgentQueueRow> {
    if (taskIds.length === 0) return new Map();
    // Cap the in-clause size at a defensive 500 — kanban views
    // should never need more, and a runaway caller shouldn't melt
    // SQLite. Higher counts get silently truncated; tests pin the
    // shape on a 600-element call.
    const ids = taskIds.slice(0, 500);
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare<string[], Row>(
        `SELECT q.* FROM mo_agent_queue q
          INNER JOIN (
            SELECT task_id, MAX(created_at) AS max_ts
              FROM mo_agent_queue
             WHERE task_id IN (${placeholders})
             GROUP BY task_id
          ) latest ON q.task_id = latest.task_id AND q.created_at = latest.max_ts`,
      )
      .all(...ids);
    const out = new Map<string, AgentQueueRow>();
    for (const row of rows) {
      const agent = rowToAgent(row);
      out.set(agent.taskId, agent);
    }
    return out;
  }

  /**
   * Atomic claim of the next pending row for a folder, capped at
   * `MAX_INFLIGHT_PER_FOLDER`. The transaction reads the cap count +
   * picks the oldest pending row + UPDATEs its state to `fix_running`
   * + stamps `claimed_at`, all under one SQLite transaction. Two
   * concurrent callers see at most one win.
   *
   * Returns the just-claimed row, or null when the cap is full or
   * the queue is empty.
   *
   * NOTE: `active_pid` is left NULL — the caller spawns the agent
   * process and writes the pid via `setActivePid()`. Stale-recovery
   * tolerates rows where `claimed_at` is set but `active_pid` is null
   * (claim window crashed before the spawn could complete).
   */
  claimNext(folderId: string, now: number = Date.now()): AgentQueueRow | null {
    const tx = this.db.transaction((folderArg: string, nowArg: number) => {
      const cap = this.db
        .prepare<[string], { c: number }>(
          `SELECT COUNT(*) AS c FROM mo_agent_queue
            WHERE folder_id = ?
              AND state IN ('pending','fix_running','fix_review','review_running','reopened')`,
        )
        .get(folderArg);
      // Pending counts toward the cap, so this is "claim only if there
      // are slots once you account for ALL non-terminal rows" — but
      // pending IS one of them, so a single pending row in an empty
      // folder still gets picked.
      const running = (cap?.c ?? 0) -
        (this.db
          .prepare<[string], { c: number }>(
            `SELECT COUNT(*) AS c FROM mo_agent_queue
              WHERE folder_id = ? AND state = 'pending'`,
          )
          .get(folderArg)?.c ?? 0);
      if (running >= MAX_INFLIGHT_PER_FOLDER) return null;
      const candidate = this.db
        .prepare<[string], Row>(
          `SELECT * FROM mo_agent_queue
            WHERE folder_id = ? AND state = 'pending'
            ORDER BY created_at ASC
            LIMIT 1`,
        )
        .get(folderArg);
      if (!candidate) return null;
      const result = this.db
        .prepare(
          `UPDATE mo_agent_queue
              SET state = 'fix_running',
                  claimed_at = ?,
                  attempts = attempts + 1,
                  updated_at = ?
            WHERE id = ? AND state = 'pending'`,
        )
        .run(nowArg, nowArg, candidate.id);
      if (result.changes !== 1) return null;
      return this.getById(candidate.id);
    });
    return tx(folderId, now);
  }

  /**
   * Move a row from one state to another, with optimistic-lock on the
   * source state. Use for every legitimate transition: fix_running →
   * fix_review, fix_review → review_running, review_running → reopened
   * / done / failed, reopened → fix_running (resume next tick), etc.
   *
   * `patch` lets the caller persist auxiliary fields atomically with
   * the state change — `lastVerdict` on the review→done edge,
   * `lastError` on a failure, `reopenCount++` on a reopen, etc.
   *
   * Returns the resulting row, or null when the source state didn't
   * match (race lost, or caller has stale info).
   */
  transition(
    id: string,
    expectFrom: AgentQueueState,
    toState: AgentQueueState,
    patch: Partial<{
      attempts: number;
      reopenCount: number;
      worktreeName: string | null;
      fixSessionId: string | null;
      reviewSessionId: string | null;
      lastVerdict: string | null;
      lastError: string | null;
      activePid: number | null;
      sessionGroupId: string | null;
      // claimed_at is intentionally excluded — it's owned by claim/release
      // semantics, not by application-level state changes.
    }> = {},
    now: number = Date.now(),
  ): AgentQueueRow | null {
    const sets: string[] = ['state = ?', 'updated_at = ?'];
    const params: unknown[] = [toState, now];
    if (TERMINAL_STATES.has(toState)) {
      // Terminal rows release the slot AND drop the active_pid (no
      // process can be alive on a terminal row by definition).
      sets.push('claimed_at = NULL', 'active_pid = NULL');
    }
    if (patch.attempts !== undefined) {
      sets.push('attempts = ?');
      params.push(patch.attempts);
    }
    if (patch.reopenCount !== undefined) {
      sets.push('reopen_count = ?');
      params.push(patch.reopenCount);
    }
    if (patch.worktreeName !== undefined) {
      sets.push('worktree_name = ?');
      params.push(patch.worktreeName);
    }
    if (patch.fixSessionId !== undefined) {
      sets.push('fix_session_id = ?');
      params.push(patch.fixSessionId);
    }
    if (patch.reviewSessionId !== undefined) {
      sets.push('review_session_id = ?');
      params.push(patch.reviewSessionId);
    }
    if (patch.lastVerdict !== undefined) {
      sets.push('last_verdict = ?');
      params.push(patch.lastVerdict);
    }
    if (patch.lastError !== undefined) {
      sets.push('last_error = ?');
      params.push(patch.lastError);
    }
    if (patch.activePid !== undefined) {
      sets.push('active_pid = ?');
      params.push(patch.activePid);
    }
    if (patch.sessionGroupId !== undefined) {
      sets.push('session_group_id = ?');
      params.push(patch.sessionGroupId);
    }
    params.push(id, expectFrom);
    const result = this.db
      .prepare(
        `UPDATE mo_agent_queue
            SET ${sets.join(', ')}
          WHERE id = ? AND state = ?`,
      )
      .run(...params);
    if (result.changes !== 1) return null;
    return this.getById(id);
  }

  /**
   * Set `active_pid` after spawning the child process. Caller must
   * already hold the row in a running state (`fix_running` /
   * `review_running`); this is a pure side-effect write, no state
   * change. Idempotent.
   */
  setActivePid(id: string, pid: number | null, now: number = Date.now()): void {
    this.db
      .prepare(
        `UPDATE mo_agent_queue
            SET active_pid = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(pid, now, id);
  }

  /**
   * Stale-recovery: rows in a running state whose `claimed_at` is
   * older than `staleMs` are forcibly released. The row reverts to
   * the preceding state (`fix_running → pending`,
   * `review_running → fix_review`), `active_pid` clears, `attempts`
   * is bumped (we're paying for a retry).
   *
   * If `attempts >= MAX_ATTEMPTS_BEFORE_FAILED` after the bump, the
   * row goes straight to `failed` with `last_error = 'stuck'` so a
   * wedged ticket doesn't loop forever.
   *
   * Called at the start of every orchestrator tick (#6) with a 15-min
   * default — longer than any reasonable agent run, and consistent
   * with the precedent on `mo_metadata_queue.releaseStuck`.
   *
   * Returns counts for observability.
   */
  releaseStuck(
    staleMs: number,
    now: number = Date.now(),
  ): { released: number; failed: number } {
    const cutoff = now - staleMs;
    const stuck = this.db
      .prepare<[number], Row>(
        `SELECT * FROM mo_agent_queue
          WHERE state IN ('fix_running','review_running')
            AND claimed_at IS NOT NULL
            AND claimed_at < ?`,
      )
      .all(cutoff);
    let released = 0;
    let failed = 0;
    for (const row of stuck) {
      const nextAttempts = row.attempts + 1;
      const goingToFail = nextAttempts >= MAX_ATTEMPTS_BEFORE_FAILED;
      if (goingToFail) {
        const r = this.db
          .prepare(
            `UPDATE mo_agent_queue
                SET state = 'failed',
                    attempts = ?,
                    active_pid = NULL,
                    claimed_at = NULL,
                    last_error = COALESCE(last_error, 'stuck'),
                    updated_at = ?
              WHERE id = ? AND state = ?`,
          )
          .run(nextAttempts, now, row.id, row.state);
        if (r.changes === 1) failed++;
      } else {
        const previous: AgentQueueState =
          row.state === 'fix_running' ? 'pending' : 'fix_review';
        const r = this.db
          .prepare(
            `UPDATE mo_agent_queue
                SET state = ?,
                    attempts = ?,
                    active_pid = NULL,
                    claimed_at = NULL,
                    last_error = COALESCE(last_error, 'stuck'),
                    updated_at = ?
              WHERE id = ? AND state = ?`,
          )
          .run(previous, nextAttempts, now, row.id, row.state);
        if (r.changes === 1) released++;
      }
    }
    return { released, failed };
  }

  /**
   * Cancel every in-flight row for a folder — used by the toggle-off
   * killer in #9 after it SIGTERMs the active processes. Returns the
   * rows that were transitioned (caller needs them to know which PIDs
   * to kill + which worktrees to clean).
   */
  cancelAllInFlightForFolder(
    folderId: string,
    reason: string = 'toggle-off',
    now: number = Date.now(),
  ): AgentQueueRow[] {
    const tx = this.db.transaction((folderArg: string) => {
      const rows = this.db
        .prepare<[string], Row>(
          `SELECT * FROM mo_agent_queue
            WHERE folder_id = ?
              AND state IN ('pending','fix_running','fix_review','review_running','reopened')
            ORDER BY created_at ASC`,
        )
        .all(folderArg);
      const cancelled: AgentQueueRow[] = [];
      const updateStmt = this.db.prepare(
        `UPDATE mo_agent_queue
            SET state = 'cancelled',
                last_error = ?,
                claimed_at = NULL,
                active_pid = NULL,
                updated_at = ?
          WHERE id = ?
            AND state IN ('pending','fix_running','fix_review','review_running','reopened')`,
      );
      for (const row of rows) {
        const r = updateStmt.run(reason, now, row.id);
        if (r.changes === 1) {
          cancelled.push(
            rowToAgent({
              ...row,
              state: 'cancelled',
              claimed_at: null,
              active_pid: null,
              last_error: reason,
              updated_at: now,
            }),
          );
        }
      }
      return cancelled;
    });
    return tx(folderId);
  }

  /** Wipe history for a folder. Tests + folder-deletion path. */
  clearFolder(folderId: string): void {
    this.db.prepare('DELETE FROM mo_agent_queue WHERE folder_id = ?').run(folderId);
  }
}

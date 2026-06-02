-- Auto-code Phase 1 — durable queue for the kanban → Claude → Codex → Mo loop.
--
-- Sub-ticket: 01KQEEACDFVWCW0WW86D6ZDHAB
-- Umbrella:   01KQANTZDKW6QH461AK2JN3DCQ
--
-- ONE row per ticket the auto-code orchestrator is working on. The row
-- moves through a state machine:
--
--   pending → fix_running → fix_review → review_running →
--     ├─ approve  → done
--     ├─ reopen   → reopened → fix_running (resume same fix_session_id)
--     └─ escalate → failed
--
-- Plus terminal `cancelled` (set by the toggle-off killer in #9 — it
-- SIGTERMs `active_pid` and flips state).
--
-- Differences from `mo_metadata_queue` (which we mirror in shape but
-- not in semantics):
--
--   * One row per task, not per (folder, note, tier). The row carries
--     state across the full fix→review→reopen ladder.
--   * No coalescing on body_hash — the row is the work-item, not a
--     dirty-mark. Re-enqueuing while in flight is a no-op (handled by
--     the partial unique index below).
--   * `fix_session_id` + `review_session_id` are PERSISTENT — they
--     identify Claude/Codex sessions on disk that we resume. Stale
--     rows can lose them (process crash mid-LLM); the worker is
--     tolerant of NULL on retry.
--   * `active_pid` is the spawned `claude`/`codex` process PID — used
--     by the toggle-off killer to SIGTERM in-flight work without
--     waiting for the LLM to finish.
--
-- The partial unique index is the coalescing primitive. INSERT for
-- (folder_id, task_id) where the prior row is already terminal
-- (done/failed/cancelled) succeeds (a re-enqueue starts fresh); INSERT
-- where a non-terminal row exists fails with SQLITE_CONSTRAINT, which
-- the repository catches and treats as a no-op dedup.

CREATE TABLE IF NOT EXISTS mo_agent_queue (
  id                 TEXT PRIMARY KEY,
  folder_id          TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  task_id            TEXT NOT NULL REFERENCES notes(id)   ON DELETE CASCADE,
  state              TEXT NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  reopen_count       INTEGER NOT NULL DEFAULT 0,
  repo_path          TEXT NOT NULL,
  worktree_name      TEXT,
  fix_session_id     TEXT,
  review_session_id  TEXT,
  last_verdict       TEXT,
  last_error         TEXT,
  active_pid         INTEGER,
  -- Reserved for sub-ticket 01KQEEF7T0MYYTJ662JQMS62AE (related-tickets
  -- session sharing via cluster JOIN). Phase 1 writes a fresh ULID per
  -- row; Phase 5 will overwrite when joining an existing in-flight
  -- session group.
  session_group_id   TEXT,
  claimed_at         INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- Coalescing primitive: at most one in-flight row per (folder, task).
-- Terminal rows (done/failed/cancelled) accumulate as history; a new
-- enqueue against a task whose only rows are terminal succeeds.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_agent_queue_inflight_unique
  ON mo_agent_queue(folder_id, task_id)
  WHERE state NOT IN ('done', 'cancelled', 'failed');

-- Worker pull path: claim oldest pending row for a given folder.
CREATE INDEX IF NOT EXISTS idx_mo_agent_queue_pending_pick
  ON mo_agent_queue(folder_id, state, created_at)
  WHERE state = 'pending';

-- Cap-check + toggle-off enumeration: every running/queued row for a folder.
CREATE INDEX IF NOT EXISTS idx_mo_agent_queue_inflight_by_folder
  ON mo_agent_queue(folder_id, state)
  WHERE state IN ('pending', 'fix_running', 'fix_review', 'review_running', 'reopened');

-- Stale-recovery scan: claimed_at predicate, narrow to the running states
-- that hold a live process.
CREATE INDEX IF NOT EXISTS idx_mo_agent_queue_running_claimed_at
  ON mo_agent_queue(state, claimed_at)
  WHERE state IN ('fix_running', 'review_running');

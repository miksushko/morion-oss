/**
 * Auto-code Phase 1 — durable queue for the kanban → Claude → Codex → Mo loop
 * (umbrella `01KQANTZDKW6QH461AK2JN3DCQ`, sub-ticket `01KQEEACDFVWCW0WW86D6ZDHAB`).
 *
 * Originally a 612-LOC single file. Re-split 2026-05-16 (ticket
 * `01KRQYRP1KPN25W5F4PTC7E9XJ`) into:
 *   - `./queue/types.ts`        — state enum + state-set consts + caps + AgentQueueRow + EnqueueOptions/Result
 *   - `./queue/row-mapping.ts`  — internal SQLite Row shape + rowToAgent mapper
 *   - `./queue/repository.ts`   — AgentQueueRepository class (cohesive state machine; ~440 LOC)
 *
 * This barrel re-exports the public surface so 11 importers stay untouched.
 *
 * Shape mirrors `MoMetadataQueueRepository` for consistency
 * (claim/release/stale-recovery primitives), but the semantics differ:
 *
 *   - One row per ticket the orchestrator is working on, NOT a
 *     coalescing dirty-mark. Re-enqueue while in flight is a deliberate
 *     no-op (the partial unique index in migration 0021 enforces it).
 *
 *   - Rows live across a multi-step state machine — `pending →
 *     fix_running → fix_review → review_running → (done|reopened|failed)`
 *     plus terminal `cancelled` for the toggle-off killer in #9. Each
 *     transition preserves persistent fields (session ids, repo path,
 *     reopen counter).
 *
 *   - Concurrency cap is per-folder, hardcoded `MAX_INFLIGHT = 5` in
 *     `./queue/types.ts`. Enforced inside `claimNext` so two scheduler
 *     instances can't both blow past the cap.
 *
 *   - Stale recovery resets `*_running` rows whose `claimed_at` is
 *     older than `staleMs` back to the pre-running state and bumps
 *     `attempts`. After `MAX_ATTEMPTS = 3` the row goes to `failed` so
 *     a wedged ticket doesn't loop forever.
 *
 *   - The state machine is enforced by `transition()` taking
 *     `expectFrom` — the UPDATE only fires when the row is still in
 *     that state. Two concurrent workers racing on the same row → only
 *     one wins; the loser sees `null` and bails.
 *
 * The queue does NOT spawn processes, manage worktrees, or read note
 * content — it's pure SQLite state.
 */

export {
  type AgentQueueState,
  TERMINAL_STATES,
  RUNNING_STATES,
  IN_FLIGHT_STATES,
  MAX_INFLIGHT_PER_FOLDER,
  MAX_ATTEMPTS_BEFORE_FAILED,
  type AgentQueueRow,
  type EnqueueOptions,
  type EnqueueResult,
} from './queue/types.js';
export { AgentQueueRepository } from './queue/repository.js';

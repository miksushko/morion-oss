import { ulid } from 'ulid';

import { worktreePath as defaultWorktreePath } from '../worktree-paths.js';
import { runPreflight as defaultRunPreflight } from '../preflight.js';

import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from './default-autocode.js';
import type { TrunkSnapshot } from '../trunk-guard.js';

import {
  MAX_INFLIGHT_PER_FOLDER,
  WORKTREE_NAME_PREFIX,
  normaliseResolved,
  type EnqueueOutcome,
  type EnsureWorktreeArgs,
  type EnsureWorktreeFn,
  type ResolvedWorkflow,
  type WorkflowOrchestratorDeps,
} from './workflow-orchestrator/types.js';
import {
  defaultCleanupWorktree,
  defaultEnsureWorktree,
} from './workflow-orchestrator/helpers.js';
import { enqueueTicket } from './workflow-orchestrator/admission.js';
import { buildHooks } from './workflow-orchestrator/hooks.js';

// Re-export for back-compat with src/server/auto-code-factory.ts and
// the existing test suites — they import these symbols from
// '../core/auto-code/workflows/workflow-orchestrator.js'. New code
// SHOULD import from the per-submodule path under
// `./workflow-orchestrator/`.
export {
  MAX_INFLIGHT_PER_FOLDER,
  WORKTREE_NAME_PREFIX,
  type EnqueueOutcome,
  type EnsureWorktreeArgs,
  type EnsureWorktreeFn,
  type ResolvedWorkflow,
  type WorkflowOrchestratorDeps,
};

/**
 * Auto-code Workflow Builder L2.T7.A — bridge layer that wraps
 * `WorkflowRunner` with the admission-control flow the legacy
 * orchestrator owns today.
 *
 * Umbrella:    01KR5F21709BKA6SFHWRFFVVPY
 * Design doc:  01KR5TMKE9GZGXTQ2BCTWCXVD5 §4 (L2.T7)
 *
 * Responsibilities:
 *
 *   1. `enqueueTicket(taskId, folderId)` — preflight (claude binary +
 *      MCP install detection) → folder-settings gates (Mo enabled +
 *      auto-code enabled + linked repo present) → atomic claim of
 *      a `workflow_runs` row → build `TicketContext` from notes +
 *      recent comments → compute fresh worktree path →
 *      `ensureWorktree` on disk → re-check ticket status →
 *      `runner.dispatchExisting(...)`.
 *
 *   2. `cancelTicket(folderId, ticketId, reason)` — look up the
 *      active workflow_run for the (folder, ticket) pair via
 *      `repo.findActiveRunForTicket` and call `runner.cancel(runId)`.
 *
 *   3. `recoverStaleRuns()` — delegate to `runner.recoverStaleRuns()`
 *      (T6 already shipped — exposed here so a single startup hook
 *      drives both layers).
 *
 *   4. `resumeFromHumanGate(input)` — proxy to the runner's resume
 *      hook with rebuilt ticket context + hooks (Phase 5).
 *
 * # File layout (2026-05-16 refactor)
 *
 * This file holds the public class + the four entry-point methods
 * that drive the run lifecycle. Per-phase logic lives in dedicated
 * sibling modules under `./workflow-orchestrator/`:
 *
 *   - `types.ts`       OrchestratorDeps / EnqueueOutcome / Ensure*
 *                      / ResolvedWorkflow + the two public constants
 *                      (WORKTREE_NAME_PREFIX / MAX_INFLIGHT_PER_FOLDER)
 *   - `helpers.ts`     Pure utilities — describeAgentChain /
 *                      stageDescriptor / findReopenTargetStageId /
 *                      collectRequiredAgents / formatActor / snippet /
 *                      defaultEnsureWorktree / defaultCleanupWorktree
 *                      / sanitiseBranchName / execGit / capitalise
 *   - `admission.ts`   enqueueTicket — the 280-LOC admission flow:
 *                      preflight + gates + dedupe + claim + worktree
 *                      setup + dispatch
 *   - `hooks.ts`       buildHooks — the 470-LOC RunnerHooks composer:
 *                      onRunStart (trunk-guard snapshot + footprint),
 *                      onStageStart (reopen-loop attempt > 1),
 *                      onStageEnd (Mo summary post + fix→review move),
 *                      onRunTerminal (trunk-guard audit + revert +
 *                      done/failed/cancelled branch)
 *   - `escalation.ts`  makeAttachedHandle (dedupe attach) +
 *                      openEscalationChat (Ask Mo session opener) +
 *                      buildRecentCommentsBlock (prompt-context builder)
 *
 * Phase functions take the orchestrator instance as their first
 * argument so they can read deps + tuning knobs without becoming
 * class methods. Class fields are exposed as `readonly` (no `private`
 * modifier) to enable this pattern — the phase modules ARE the
 * orchestrator's implementation, just lifted out for file-size hygiene
 * per CLAUDE.md "Small files" rule.
 */
export class WorkflowOrchestrator {
  readonly preflightImpl: NonNullable<WorkflowOrchestratorDeps['preflightImpl']>;
  readonly worktreePathImpl: NonNullable<
    WorkflowOrchestratorDeps['worktreePathImpl']
  >;
  readonly ensureWorktreeFn: EnsureWorktreeFn;
  readonly generateWorktreeName: NonNullable<
    WorkflowOrchestratorDeps['generateWorktreeName']
  >;
  readonly cleanupWorktreeFn: NonNullable<
    WorkflowOrchestratorDeps['cleanupWorktree']
  >;
  readonly recentCommentsLimit: number;
  readonly maxInflightPerFolder: number;
  readonly resolveDefinitionFn: (
    folderId: string,
    taskId?: string,
  ) => ResolvedWorkflow;
  readonly isAgentAvailableFn: (agent: string) => boolean;
  /** In-memory map of runId → trunk snapshot. Populated at
   *  onRunStart, consumed + cleared at onRunTerminal. If the sidecar
   *  restarts mid-run, the snapshot is lost — the audit is then
   *  skipped (the worst case: a leak isn't caught for that run).
   *  We don't persist to disk because the snapshot is large
   *  (every tracked file's blob hash) and short-lived. */
  readonly trunkSnapshots = new Map<string, TrunkSnapshot>();

  constructor(readonly deps: WorkflowOrchestratorDeps) {
    this.preflightImpl = deps.preflightImpl ?? defaultRunPreflight;
    this.worktreePathImpl = deps.worktreePathImpl ?? defaultWorktreePath;
    this.ensureWorktreeFn = deps.ensureWorktree ?? defaultEnsureWorktree;
    this.cleanupWorktreeFn = deps.cleanupWorktree ?? defaultCleanupWorktree;
    this.generateWorktreeName =
      deps.generateWorktreeName ?? (() => `${WORKTREE_NAME_PREFIX}${ulid().toLowerCase()}`);
    this.recentCommentsLimit = deps.recentCommentsLimit ?? 5;
    this.maxInflightPerFolder = deps.maxInflightPerFolder ?? MAX_INFLIGHT_PER_FOLDER;
    // Default fallback uses the LEGACY linear definition so unconfigured
    // auto-code (no per-folder workflow_template setting, no seeded
    // workflows row) keeps dispatching via the L2 linear runner until
    // the Phase 4 DAG runner ships. The v2 DEFAULT_AUTOCODE_DEFINITION
    // is what the user SEES in the editor as the canonical shape, but
    // running it before Phase 4 returns a clean workflow_not_runnable
    // — that's intentional only when the user explicitly picks a v2
    // draft. The bare "no setting wired" fallback shouldn't kill
    // auto-code for every folder simultaneously.
    const rawResolve =
      deps.resolveDefinition ?? (() => LEGACY_LINEAR_AUTOCODE_DEFINITION);
    this.resolveDefinitionFn = (folderId, taskId) =>
      normaliseResolved(rawResolve(folderId, taskId));
    this.isAgentAvailableFn = deps.isAgentAvailable ?? (() => true);
  }

  /**
   * Admission control + dispatch. Delegates to the standalone
   * `enqueueTicket` in ./workflow-orchestrator/admission.ts — see that
   * module for the 280-LOC gate / dedupe / claim / worktree-setup /
   * dispatch flow.
   */
  enqueueTicket(taskId: string, folderId: string): Promise<EnqueueOutcome> {
    return enqueueTicket(this, taskId, folderId);
  }

  /**
   * Cancel any active workflow_run for the (folder, ticket) pair.
   * No-op when there is no active run. The runner observes the
   * cancel flag between stages and via the in-flight adapter
   * handle's `cancel()` (T4 + Codex review fix for spawn-handshake
   * race).
   */
  async cancelTicket(
    folderId: string,
    ticketId: string,
    reason: string = 'parent_handle_cancel',
  ): Promise<{ cancelledRunId: string | null }> {
    const active = this.deps.runsRepo.findActiveRunForTicket(folderId, ticketId);
    if (!active) return { cancelledRunId: null };
    await this.deps.runner.cancel(active.id, reason);
    return { cancelledRunId: active.id };
  }

  /**
   * Sweep orphan runs left by a previous process (sidecar crash,
   * force-quit, hot-reload mid-run). The runner flips the
   * `workflow_runs` row to `failed` with
   * `lastError='interrupted_by_restart'` — but its per-run hook
   * state died with the old process, so without extra wiring the
   * ticket would stay in `doing` with the last live comment
   * ("Auto-code picked this up. Started a fresh worktree…") as
   * the only signal. The user opens the kanban next morning and
   * sees a stuck card.
   *
   * Fix: after the DB sweep, fire the same `onRunTerminal` side
   * effects each in-process run gets — move the ticket back to
   * `backlog`, tag it `auto-code-paused`, post an explanation
   * comment. Hooks are rebuilt fresh per recovered run via
   * `buildHooks` (same composer the admission path uses), so
   * trunk-guard / Mo footprints / etc. stay aligned with the
   * live-run path.
   *
   * Fire-and-forget: this runs at sidecar startup and we don't
   * block boot on N comment posts. Hook errors are advisory.
   */
  recoverStaleRuns(): { recoveredRunIds: string[] } {
    const result = this.deps.runner.recoverStaleRuns();
    for (const runId of result.recoveredRunIds) {
      const run = this.deps.runsRepo.getRun(runId);
      if (!run) continue;
      const worktreeName = run.worktreePath.split('/').pop() ?? '';
      const hooks = buildHooks(this, run.ticketId, worktreeName);
      void Promise.resolve()
        .then(() => hooks.onRunTerminal?.(run))
        .catch((err) => {
          console.warn(
            `[workflow-orchestrator] recoverStaleRuns onRunTerminal threw for run ${runId}:`,
            err,
          );
        });
    }
    return result;
  }

  /**
   * Phase 5 — proxy to the runner's resume hook. Resolves the ticket
   * context from the run's folder + ticket id so the chat-route hook
   * doesn't need to plumb it explicitly.
   */
  async resumeFromHumanGate(input: {
    runId: string;
    userReply: string;
  }): Promise<void> {
    const run = this.deps.runsRepo.getRun(input.runId);
    if (!run) return;
    const note = this.deps.notes.getById(run.ticketId);
    const ticketContext = {
      id: run.ticketId,
      title: note?.title ?? '',
      body: note?.body ?? '',
    };
    // Derive the worktreeName the same way the regular dispatch
    // does — buildHooks needs both (taskId, worktreeName) so trunk-
    // guard + Mo footprints fire under resume too.
    const worktreeName = run.worktreePath.split('/').pop() ?? '';
    // Fire-and-forget — the runner re-enters dispatch internally.
    // We don't await the terminal because resume can take minutes
    // (downstream cli_agent stages) and the chat-route caller wants
    // a fast 200 OK.
    const handle = this.deps.runner.resumeFromHumanGate({
      runId: input.runId,
      userReply: input.userReply,
      ticketContext,
      hooks: buildHooks(this, run.ticketId, worktreeName),
    });
    // Touch the handle so unawaited terminal doesn't UnhandledRejection.
    void handle.awaitTerminal().catch(() => {});
  }
}

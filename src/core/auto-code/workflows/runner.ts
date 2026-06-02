import { sleep } from './runner-helpers.js';
import { dispatchDag } from './dispatch-dag.js';
import { dispatchLinear } from './dispatch-linear.js';

import { parseRunnableWorkflow } from './parse-linear.js';
import type { WorkflowRunRow, WorkflowStage } from './types/index.js';
import {
  DEFAULT_MO_STAGE_DISPATCHER,
  type MoStageDispatcher,
} from './mo-stage-dispatcher.js';

import {
  PASS_THROUGH_BUDGET_GUARD,
  DEFAULT_HUMAN_GATE_HANDLER,
  DEFAULT_MCP_TOOL_DISPATCHER,
} from './runner-defaults.js';
import type {
  BudgetGuard,
  HumanGateHandler,
  McpToolDispatcher,
  InternalRunState,
  RunHandle,
  RunnerHooks,
  StageExecutorContext,
  StartRunInput,
  TicketContext,
  WorkflowRunnerDeps,
} from './runner-types.js';

// Re-export the public surface for back-compat with external callers
// (server factory, orchestrator, tests) that import from `./runner`.
export {
  REJECTED_BY_WORKFLOW_PREFIX,
  PASS_THROUGH_BUDGET_GUARD,
  DEFAULT_HUMAN_GATE_HANDLER,
  DEFAULT_MCP_TOOL_DISPATCHER,
} from './runner-defaults.js';
export type {
  BudgetGuard,
  HumanGateHandler,
  HumanGateHandlerArgs,
  HumanGateHandlerResult,
  BudgetGuardContext,
  BudgetVerdict,
  McpToolDispatchResult,
  McpToolDispatcher,
  RunHandle,
  RunnerHooks,
  StartRunInput,
  TicketContext,
  WorkflowRunnerDeps,
} from './runner-types.js';

/**
 * Auto-code Workflow Builder L2.T4 — `WorkflowRunner` engine.
 *
 * Walks the linear pipeline of a `WorkflowDefinition`, dispatching each
 * `cli_agent` stage through the L1 harness adapter API. Persists every
 * transition through `WorkflowRunsRepository` so app-restart resume
 * (L2.T6) and UI rendering have a durable source of truth.
 *
 * Out of scope for T4 (parked for follow-up tickets):
 *
 *   * Per-stage budget cap pre-flight enforcement (T5). Today the
 *     `maxBudgetUsd` flag is forwarded to the adapter; the adapter
 *     surfaces `terminalReason: 'budget'` when the cap is hit but the
 *     runner does not block dispatch on prior accumulated cost.
 *   * Resume-on-restart sweep (T6). The schema supports it (active
 *     status partial index, snapshot graph + repo + worktree); T6 adds
 *     the orchestration.
 *   * `mo_spend_ledger` writes (T8). Today the runner only updates
 *     `workflow_runs.total_cost_usd` — gated on the production ledger
 *     fix (`01KQ1H556RFFKD7WGZE77MEVFQ`).
 *   * Reopen-on-review-reject loop. Today the runner runs every stage
 *     to terminal exactly once; the legacy orchestrator's reopen logic
 *     lands in T4b once verdict parsing moves into a stage-output
 *     handler.
 *   * Non-cli_agent stage kinds. The parser rejects them; this engine
 *     defends in depth and fails the run with a clear error if a
 *     graph-snapshot reaches dispatch with one anyway.
 */


export class WorkflowRunner {
  private readonly states = new Map<string, InternalRunState>();
  private readonly now: () => number;
  private readonly budgetGuard: BudgetGuard;
  private readonly mcpToolDispatcher: McpToolDispatcher;
  private readonly moStageDispatcher: MoStageDispatcher;
  private readonly humanGateHandler: HumanGateHandler;
  /**
   * Frozen execution context handed to per-stage executor modules.
   * Bundles the resolved (post-default) dispatcher + helper callbacks
   * bound to `this`, so executors stay framework-free.
   */
  private readonly executorCtx: StageExecutorContext;

  constructor(private readonly deps: WorkflowRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.budgetGuard = deps.budgetGuard ?? PASS_THROUGH_BUDGET_GUARD;
    this.mcpToolDispatcher =
      deps.mcpToolDispatcher ?? DEFAULT_MCP_TOOL_DISPATCHER;
    this.moStageDispatcher =
      deps.moStageDispatcher ?? DEFAULT_MO_STAGE_DISPATCHER;
    this.humanGateHandler =
      deps.humanGateHandler ?? DEFAULT_HUMAN_GATE_HANDLER;
    this.executorCtx = {
      deps: this.deps,
      now: this.now,
      budgetGuard: this.budgetGuard,
      mcpToolDispatcher: this.mcpToolDispatcher,
      moStageDispatcher: this.moStageDispatcher,
      humanGateHandler: this.humanGateHandler,
      runHook: this.runHook.bind(this),
      isCancelled: this.isCancelled.bind(this),
      terminate: this.terminate.bind(this),
      fireStageEndHook: this.fireStageEndHook.bind(this),
    };
  }

  /**
   * Start a new run OR attach to an existing active run for the
   * `(folderId, ticketId)` pair. Returns immediately with a handle;
   * the dispatch loop runs asynchronously.
   */
  async start(input: StartRunInput): Promise<RunHandle> {
    // Re-validate at the runner boundary. The dispatch loop walks
    // `graph_snapshot.stages` in array order and ignores `edges` — a
    // schema-valid but non-linear graph (mcp_tool_call / human_gate /
    // branch stages, or edges that don't match the array order)
    // would silently execute differently from what the graph
    // describes. parseLinearWorkflow re-runs the full Zod refinement
    // chain and the L2 linear-only constraints; on success we
    // snapshot the parsed value (which may have applied defaults).
    const runnableDef = parseRunnableWorkflow(input.definition);
    const { run, deduped } = this.deps.repo.createRun(
      {
        folderId: input.folderId,
        ticketId: input.ticketId,
        workflowId: input.workflowId ?? null,
        graphSnapshot: runnableDef,
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        initialStatus: 'pending',
      },
      this.now(),
    );

    if (deduped) {
      return this.attachExisting(run.id);
    }

    return this.dispatchExisting({
      runId: run.id,
      ticketContext: input.ticketContext,
      hooks: input.hooks,
    });
  }

  /**
   * Attach a handle to an existing run WITHOUT starting a new
   * dispatch loop. Used by upper layers (e.g. WorkflowOrchestrator)
   * on the dedupe path: a concurrent enqueue already claimed the
   * row + started its own dispatcher; the duplicate caller wants
   * to observe the run's terminal state without spawning a second
   * loop. If the run is owned by THIS process, the handle reflects
   * the live in-process terminalPromise (so hooks, cost, etc. are
   * current); otherwise it polls the row to terminal.
   *
   * Throws if the row doesn't exist.
   */
  attachExisting(runId: string): RunHandle {
    const existing = this.states.get(runId);
    if (existing) {
      return {
        runId,
        awaitTerminal: () => existing.terminalPromise,
        cancel: (reason) => this.cancel(runId, reason ?? 'parent_handle_cancel'),
        deduped: true,
      };
    }
    const row = this.deps.repo.getRun(runId);
    if (!row) {
      throw new Error(`attachExisting: run ${runId} not found`);
    }
    if (
      row.status === 'done' ||
      row.status === 'failed' ||
      row.status === 'cancelled'
    ) {
      return {
        runId,
        awaitTerminal: async () => row,
        cancel: async () => {},
        deduped: true,
      };
    }
    return this.makeAttachedHandle(runId, true);
  }

  /**
   * Drive a JUST-CLAIMED pending workflow_run row through the
   * dispatch loop. The orchestrator owns row creation via the
   * partial unique index (atomic admission); this method picks up
   * the claimed row and starts the in-process dispatcher.
   *
   * Defensive narrowing — refuses to start a fresh dispatcher when:
   *   - this process already has in-process state for the runId
   *     (returns the existing handle)
   *   - the row is already terminal (returns immediate handle)
   *   - the row is non-pending (`running` / `paused_ask_user`) AND
   *     we don't own it — falls back to attach. Starting a second
   *     dispatcher for an already-running row would race on stage
   *     spawns; bail.
   *
   * Throws if the row doesn't exist.
   */
  dispatchExisting(input: {
    runId: string;
    ticketContext: TicketContext;
    hooks?: RunnerHooks;
  }): RunHandle {
    const existingState = this.states.get(input.runId);
    if (existingState) {
      return {
        runId: input.runId,
        awaitTerminal: () => existingState.terminalPromise,
        cancel: (reason) =>
          this.cancel(input.runId, reason ?? 'parent_handle_cancel'),
        deduped: true,
      };
    }

    const row = this.deps.repo.getRun(input.runId);
    if (!row) {
      throw new Error(`dispatchExisting: run ${input.runId} not found`);
    }
    // Already terminal? Return a handle that resolves immediately.
    if (
      row.status === 'done' ||
      row.status === 'failed' ||
      row.status === 'cancelled'
    ) {
      return {
        runId: input.runId,
        awaitTerminal: async () => row,
        cancel: async () => {},
        deduped: true,
      };
    }
    // Non-pending + not owned by this process → another runner
    // owns it. Starting a second dispatch loop would race on stage
    // spawns; attach via polling instead.
    if (row.status !== 'pending') {
      return this.makeAttachedHandle(input.runId, true);
    }

    let resolve!: (row: WorkflowRunRow) => void;
    const terminalPromise = new Promise<WorkflowRunRow>((r) => {
      resolve = r;
    });
    const state: InternalRunState = {
      runId: input.runId,
      currentAdapterHandle: null,
      cancelReason: null,
      stageOutputs: {},
      reopenContext: {},
      hooks: input.hooks ?? {},
      terminalPromise,
      terminalResolve: resolve,
    };
    this.states.set(input.runId, state);

    // Fire-and-forget dispatch. Errors inside dispatch flow into the
    // run row's status/lastError — they don't escape this method.
    void dispatchLinear(this.executorCtx, state, input.ticketContext).finally(() => {
      this.states.delete(input.runId);
    });

    return {
      runId: input.runId,
      awaitTerminal: () => terminalPromise,
      cancel: (reason) =>
        this.cancel(input.runId, reason ?? 'parent_handle_cancel'),
      deduped: false,
    };
  }

  /**
   * Cancel an in-flight run. Idempotent. Resolves once the cancel
   * flag is persisted AND the in-flight adapter handle (if any) has
   * been signalled — the dispatch loop will then observe the flag
   * and write the terminal `cancelled` row.
   */
  async cancel(runId: string, reason: string = 'parent_handle_cancel'): Promise<void> {
    this.deps.repo.updateRun(runId, { cancelRequested: true }, this.now());
    const state = this.states.get(runId);
    if (state) {
      // ALWAYS persist the reason on in-process state — the dispatch
      // loop's pre-spawn / post-assignment re-checks read this. If
      // currentAdapterHandle is null right now (the spawn handshake
      // hasn't completed yet), the runner picks up the flag once
      // spawn resolves and signals the freshly-assigned handle.
      state.cancelReason = reason;
      if (state.currentAdapterHandle) {
        // Adapter cancel is itself idempotent; safe to call many times.
        await state.currentAdapterHandle.cancel(reason);
      }
    }
  }

  /**
   * Sweep `workflow_runs` for active rows left behind by a previous
   * process (sidecar crash, force-quit, OS sleep-wake glitch). Marks
   * each run + every non-terminal stage row as `failed` with
   * `lastError='interrupted_by_restart'`.
   *
   * Real session resume via the adapter's `--resume` flag is deferred
   * to L3 (where ask_user pause/resume actually needs it). For L2 the
   * cleanest contract is "every run that survived a restart is
   * intentionally orphaned" — the user re-drags the ticket if they
   * want a fresh attempt.
   *
   * Idempotent and safe to call before any `start()`. Returns the
   * list of run ids that were recovered (empty when there was no
   * orphaned state).
   *
   * NOTE: this method ONLY touches DB rows — it does not chase down
   * `active_pid` values to SIGKILL stragglers. The orphan-watch in
   * `src/server/orphan-watch.ts` (zombie-sidecar prevention, v1.4.6)
   * already self-kills surviving sidecars; without a sidecar to
   * harbour the worker, the process is gone.
   */
  recoverStaleRuns(): { recoveredRunIds: string[] } {
    const { repo } = this.deps;
    const now = this.now();
    const orphans = repo.listActiveRuns();
    const recoveredRunIds: string[] = [];
    for (const run of orphans) {
      // Skip rows we own in this process — those have a live dispatch
      // loop driving them. Recovery is only for rows whose loop is gone.
      if (this.states.has(run.id)) continue;
      for (const stage of repo.listStagesForRun(run.id)) {
        if (stage.status === 'pending' || stage.status === 'running') {
          repo.updateStage(
            stage.id,
            {
              status: 'failed',
              activePid: null,
              lastError: 'interrupted_by_restart',
              finishedAt: now,
            },
            now,
          );
        }
      }
      repo.updateRun(
        run.id,
        {
          status: 'failed',
          currentStageId: null,
          lastError: 'interrupted_by_restart',
          finishedAt: now,
        },
        now,
      );
      recoveredRunIds.push(run.id);
    }
    return { recoveredRunIds };
  }

  /**
   * Invoke a lifecycle hook. Throws are caught + logged to console
   * so a buggy observer can't escalate to the run. The hook is
   * awaited — slow hooks delay the next stage by design (a kanban
   * move needs to land before the user-facing card swap is visible).
   */
  private async runHook<T>(
    label: string,
    hook: ((arg: T) => void | Promise<void>) | undefined,
    arg: T,
  ): Promise<void> {
    if (!hook) return;
    try {
      await hook(arg);
    } catch (err) {
      console.error(`[workflow-runner] hook ${label} threw:`, err);
    }
  }

  private isCancelled(state: InternalRunState): boolean {
    if (state.cancelReason !== null) return true;
    const fresh = this.deps.repo.getRun(state.runId);
    return fresh?.cancelRequested === true;
  }

  // ---- internals ---------------------------------------------------

  private makeAttachedHandle(runId: string, deduped: boolean): RunHandle {
    return {
      runId,
      awaitTerminal: async () => {
        // Poll-on-demand for runs not owned by this process. The
        // ergonomic path (same-process attach) is handled in start();
        // this branch covers cross-process or already-completed runs.
        // Resolves immediately if already terminal.
        // The polling cadence is gentle — this is a fallback path,
        // not the hot loop.
        for (;;) {
          const row = this.deps.repo.getRun(runId);
          if (!row) throw new Error(`run ${runId} vanished`);
          if (row.status === 'done' || row.status === 'failed' || row.status === 'cancelled') {
            return row;
          }
          await sleep(500);
        }
      },
      cancel: (reason) => this.cancel(runId, reason ?? 'parent_handle_cancel'),
      deduped,
    };
  }


  /** Fire `onStageEnd` with the freshest stage row + run. Shared
   *  between the success / failure / cancelled branches of
   *  `runMcpToolStage` so all three trigger the hook uniformly. */
  private async fireStageEndHook(
    state: InternalRunState,
    stage: WorkflowStage,
  ): Promise<void> {
    const updatedRow = this.deps.repo.latestAttemptForStage(
      state.runId,
      stage.id,
    );
    if (!updatedRow) return;
    const freshRun = this.deps.repo.getRun(state.runId);
    if (!freshRun) return;
    await this.runHook('onStageEnd', state.hooks.onStageEnd, {
      run: freshRun,
      stage,
      stageRow: updatedRow,
    });
  }

  /**
   * Phase 5 MVP — public resume entry. Called by the chat route's
   * POST /messages hook when the user replies in a workflow-linked
   * session. Reconstructs the in-memory run state from persistence
   * (stage outputs included), flips status back to `running`,
   * advances from the human_gate's outbound edge with the user's
   * reply threaded through `reopenContext`. Returns a fresh
   * `RunHandle` so the caller can optionally await terminal — most
   * callers fire-and-forget.
   *
   * Idempotent contract: the underlying `repo.resumeFromHumanGate`
   * atomic flip won't re-enter dispatch if the row isn't in
   * `paused_ask_user`. Two near-simultaneous user replies collapse
   * to one resume.
   */
  resumeFromHumanGate(input: {
    runId: string;
    userReply: string;
    ticketContext: TicketContext;
    hooks?: RunnerHooks;
  }): RunHandle {
    const { repo } = this.deps;
    // Cheap pre-flight — caller may pass an already-resumed/cancelled
    // run id (e.g. user double-replied; first reply already resumed
    // the run and Mo finished). Return an attached handle so the
    // caller's await works correctly.
    const row = repo.getRun(input.runId);
    if (!row) {
      // Run row vanished — synthesize a failed handle.
      return {
        runId: input.runId,
        awaitTerminal: async () => {
          throw new Error(`resumeFromHumanGate: run ${input.runId} not found`);
        },
        cancel: async () => {},
        deduped: true,
      };
    }
    if (row.status !== 'paused_ask_user') {
      return this.makeAttachedHandle(input.runId, true);
    }

    // Find the human_gate's outbound edge → resume target.
    const stages = row.graphSnapshot.stages;
    const edges = row.graphSnapshot.edges;
    const humanGateId = row.currentStageId ?? '';
    const humanGate = stages.find((s) => s.id === humanGateId);
    if (!humanGate || humanGate.kind !== 'human_gate') {
      // Misconfigured pause state — terminate so the row doesn't
      // accumulate forever.
      const now = this.now();
      repo.updateRun(
        input.runId,
        {
          status: 'failed',
          currentStageId: null,
          finishedAt: now,
          lastError: `resume_misconfigured: paused at stage "${humanGateId}" which isn't a human_gate`,
        },
        now,
      );
      const final = repo.getRun(input.runId)!;
      return {
        runId: input.runId,
        awaitTerminal: async () => final,
        cancel: async () => {},
        deduped: true,
      };
    }
    const resumeTargetId = (() => {
      for (const e of edges) {
        if (e.from === humanGate.id) return e.to;
      }
      return null;
    })();
    if (resumeTargetId === null) {
      const now = this.now();
      repo.updateRun(
        input.runId,
        {
          status: 'failed',
          currentStageId: null,
          finishedAt: now,
          lastError: 'resume_misconfigured: human_gate has no outbound edge',
        },
        now,
      );
      const final = repo.getRun(input.runId)!;
      return {
        runId: input.runId,
        awaitTerminal: async () => final,
        cancel: async () => {},
        deduped: true,
      };
    }

    // Mark the human_gate stage row 'done' with the user reply in
    // its output — downstream stages can read it via
    // stageOutputs[<human_gate_id>].output.userReply.
    const stageRow = repo.latestAttemptForStage(input.runId, humanGate.id);
    if (stageRow) {
      repo.updateStage(
        stageRow.id,
        {
          status: 'done',
          finishedAt: this.now(),
          output: {
            ...(stageRow.output ?? {}),
            userReply: input.userReply,
            resumedAt: this.now(),
          },
        },
        this.now(),
      );
    }

    // Atomic resume — flip status back to 'running'. If we lose the
    // race (concurrent cancel / second resume) bail without entering
    // dispatch.
    const resumed = repo.resumeFromHumanGate(input.runId, this.now());
    if (!resumed) {
      return this.makeAttachedHandle(input.runId, true);
    }

    // Rebuild stage outputs from persistence — runner's in-memory
    // state was discarded when dispatch returned on the original
    // pause. Read all completed stages' output_json so downstream
    // mo_stage / cli_agent prompt templates can still see prior
    // results via {{stages.<id>.output.<key>}}.
    const stageOutputs: Record<string, { output: Record<string, unknown> }> = {};
    const allStages = repo.listStagesForRun(input.runId);
    for (const s of allStages) {
      if (s.output && typeof s.output === 'object') {
        stageOutputs[s.stageIdInGraph] = { output: s.output as Record<string, unknown> };
      }
    }
    // Ensure the human_gate's just-written output is in the map
    // even if the listStagesForRun read raced the updateStage above.
    stageOutputs[humanGate.id] = {
      output: {
        ...(stageOutputs[humanGate.id]?.output ?? {}),
        userReply: input.userReply,
      },
    };

    // Build fresh internal state and re-enter the DAG walk from the
    // resume target.
    let resolve!: (row: WorkflowRunRow) => void;
    const terminalPromise = new Promise<WorkflowRunRow>((r) => {
      resolve = r;
    });
    const state: InternalRunState = {
      runId: input.runId,
      currentAdapterHandle: null,
      cancelReason: null,
      stageOutputs,
      reopenContext: {
        userReply: input.userReply,
        fromStageId: humanGate.id,
      },
      hooks: input.hooks ?? {},
      terminalPromise,
      terminalResolve: resolve,
    };
    this.states.set(input.runId, state);

    void dispatchDag(this.executorCtx, state, input.ticketContext, resumeTargetId)
      .catch(async (err) => {
        // dispatchDag itself catches stage errors and routes them
        // through terminate; this catch is the safety net for an
        // unexpected throw (e.g. corrupt snapshot).
        await this.terminate(
          state,
          'failed',
          `resume_dispatch_threw: ${(err as Error).message}`,
        );
      })
      .finally(() => {
        // states.delete fires when the walk returns OR pauses again
        // (multi-human_gate workflow). The next resume rebuilds.
        this.states.delete(input.runId);
      });

    return {
      runId: input.runId,
      awaitTerminal: () => terminalPromise,
      cancel: (reason) =>
        this.cancel(input.runId, reason ?? 'parent_handle_cancel'),
      deduped: false,
    };
  }

  private async terminate(
    state: InternalRunState,
    status: 'done' | 'failed' | 'cancelled',
    error: string | null,
  ): Promise<void> {
    const now = this.now();
    this.deps.repo.updateRun(
      state.runId,
      {
        status,
        currentStageId: null,
        finishedAt: now,
        lastError: error,
      },
      now,
    );
    const final = this.deps.repo.getRun(state.runId);
    if (final) {
      // Fire onRunTerminal BEFORE resolving the terminal promise so
      // hook errors land in stderr (caught by `runHook`) before any
      // awaiter on `awaitTerminal()` sees the final row + races into
      // its own logic. The hook MAY itself await — slow hooks delay
      // `awaitTerminal()` resolution by design (e.g. a Mo comment
      // post needs to land before the user sees `done`).
      await this.runHook('onRunTerminal', state.hooks.onRunTerminal, final);
      state.terminalResolve(final);
    }
  }
}


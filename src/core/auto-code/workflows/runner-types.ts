/**
 * Public type / interface surface for `WorkflowRunner`. Extracted out
 * of `runner.ts` so per-stage executor modules (mcp_tool_call /
 * sink / human_gate / mo_stage / cli_agent) can share the same shapes
 * without circular imports back through `runner.ts`.
 *
 * `runner.ts` re-exports every name here for back-compat with external
 * consumers (server factory, orchestrator, tests).
 *
 * Stage 2 of the runner.ts decomposition (ticket
 * 01KRJYYZ3YE57V1PM06ACBDS0T).
 */

import type { AgentHandle, CliAgentAdapter } from '../harness/adapter.js';
import type { MoStageDispatcher } from './mo-stage-dispatcher.js';
import type { WorkflowRunsRepository } from './runs-repository.js';
import type { WorktreeDiffCapture } from './worktree-diff.js';
import type {
  CliAgentName,
  WorkflowDefinition,
  WorkflowRunRow,
  WorkflowRunStageRow,
  WorkflowStage,
} from './types/index.js';

// Re-export so executor modules can re-use without a second import line.
export type { MoStageDispatcher } from './mo-stage-dispatcher.js';
export type { WorkflowRunsRepository } from './runs-repository.js';

export interface WorkflowRunnerDeps {
  repo: WorkflowRunsRepository;
  /** Returns a fresh adapter instance per stage spawn. The runner is
   *  stateless wrt adapter selection — the factory is the seam where
   *  prod wires real adapters and tests inject mocks. */
  adapterFactory: (agent: CliAgentName) => CliAgentAdapter;
  /** Dispatch an MCP tool call from inside an `mcp_tool_call` stage
   *  (Этап 4). Factory wires this via
   *  `dispatchMoTool(ALL_TOOLS, ..., toolCtx)`; tests inject a stub.
   *  Default = always-fails so tests + non-MCP-aware setups
   *  surface a clear error instead of crashing on undefined. */
  mcpToolDispatcher?: McpToolDispatcher;
  /** Where adapters write their per-run JSONL transcripts. Forwarded
   *  to `SpawnOptions.transcriptDir`; the file path used by the
   *  adapter is `<transcriptDir>/<sessionId>.jsonl`. */
  transcriptDir: string;
  /** Deterministic handoff capture ("Mo = router, not narrator",
   *  2026-07-14): post-stage `git diff --stat` + changed-file list
   *  against the pre-stage HEAD, enriching cli_agent outputs with
   *  `diffstat` / `filesChanged` facts for downstream templates.
   *  Optional — the executor falls back to the real git-backed
   *  implementation, which silently no-ops on non-repo paths. */
  worktreeDiff?: WorktreeDiffCapture;
  /** Pre-flight budget guard — runs immediately before the runner
   *  spawns each cli_agent stage. Returning `{allow: false}` short-
   *  circuits the stage with `failed` + the supplied reason recorded
   *  on `lastError`. Default = no-op pass-through (the structural
   *  seam landed in T5; the real workspace-wide auto-code budget cap
   *  lands in T8 once `mo_spend_ledger` is repaired —
   *  `01KQ1H556RFFKD7WGZE77MEVFQ`). */
  budgetGuard?: BudgetGuard;
  /** Mo decision dispatcher for `mo_stage` nodes (Phase 4 DAG
   *  runner). Returns the picked branch + free-text reason + cost.
   *  Default refuses every call with a clear error envelope so a
   *  runner wired without a Mo backend fails loudly rather than
   *  silently picking a random branch. */
  moStageDispatcher?: MoStageDispatcher;
  /** Phase 5 (ticket 01KRFT0742GY480WFJTAW02Z05) — IO side of the
   *  human_gate pause path. The runner owns the state-machine work
   *  (creating the stage row, flipping the run status, finding the
   *  resume target); the handler owns the external effects (create
   *  Ask Mo session, post Mo's question as the opening assistant
   *  message, post a visible footprint comment on the ticket). Split
   *  this way so the runner stays IO-agnostic per the L1 contract.
   *
   *  Default = fail loudly. Production factory wires the real impl;
   *  tests stub it to capture the call without actually creating a
   *  chat session. */
  humanGateHandler?: HumanGateHandler;
  /** Injectable for deterministic timestamps in tests. */
  now?: () => number;
}

/** Phase 5 — payload the runner sends to `humanGateHandler` when it
 *  reaches a `human_gate` stage. */
export interface HumanGateHandlerArgs {
  runId: string;
  folderId: string;
  ticketId: string;
  /** The human_gate stage id in the graph — useful for the handler's
   *  comment text + as a back-link for debugging. */
  humanGateStageId: string;
  /** Workflow author's optional hint to Mo about WHAT to ask the
   *  user (Phase 6 V2). Mo composes the actual chat opening message
   *  from ticket + comments + prior stage outputs + this hint at
   *  runtime. Absent / empty = compose purely from context. */
  guidance: string | undefined;
  /** Ticket title for the chat-session title + comment context. */
  ticketTitle: string;
}

export type HumanGateHandlerResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: string };

export type HumanGateHandler = (
  args: HumanGateHandlerArgs,
) => Promise<HumanGateHandlerResult>;

export interface BudgetGuardContext {
  runId: string;
  folderId: string;
  ticketId: string;
  stageId: string;
  /** The cli_agent name on this stage. */
  agent: CliAgentName;
  /** The stage's per-run cap (NULL = inherit folder cap). Forward
   *  the value to the adapter even when budgetGuard allows — the
   *  `--max-budget-usd` CLI flag still caps the agent's own spend. */
  stageMaxBudgetUsd: number | null;
  /** Cumulative cost on this run before the upcoming stage. */
  runTotalCostUsd: number;
}

export type BudgetVerdict =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export interface BudgetGuard {
  check(ctx: BudgetGuardContext): Promise<BudgetVerdict> | BudgetVerdict;
}

/** Result of an MCP tool dispatch from an `mcp_tool_call` stage.
 *  Mirrors `dispatchMoTool`'s envelope so the factory wiring is
 *  one-liner. The runner stores `data` on `stages.<id>.output`
 *  (success) OR sets `lastError` (failure). Optional `costUsd`
 *  flows up to `workflow_runs.total_cost_usd` + the stage row's
 *  `cost_usd` so MCP-stage spend (mo_ask, mo_get_context)
 *  participates in the run's cost rollup (Codex P2c, 2026-05-10). */
export type McpToolDispatchResult =
  | { ok: true; data: unknown; costUsd?: number }
  | { ok: false; error: string; message?: string };

export type McpToolDispatcher = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<McpToolDispatchResult>;

export interface StartRunInput {
  folderId: string;
  ticketId: string;
  workflowId?: string | null;
  definition: WorkflowDefinition;
  repoPath: string;
  worktreePath: string;
  /** Surface to prompt templates as `ticket.*` placeholders. */
  ticketContext: TicketContext;
  /** Optional lifecycle hooks. Surfaces stage transitions to higher
   *  layers (e.g. `WorkflowOrchestrator` posting Mo comments + kanban
   *  moves on dispatch / done / escalate, T7.B.2.b). Hooks run after
   *  the corresponding repo write so callers see the canonical row. */
  hooks?: RunnerHooks;
}

/**
 * Lifecycle hooks fired by the runner's dispatch loop. Each hook
 * receives the freshest `WorkflowRunRow` (re-read after the
 * corresponding write so DB-side defaults / CHECK constraints are
 * already applied). Hooks are awaited — a slow hook delays the next
 * stage. Throws are caught + logged, never escalated to the run.
 *
 * Reasons / verdict semantics for `onRunTerminal`:
 *   - status = 'done'      → run.lastError === null
 *   - status = 'failed'    → run.lastError carries reason prefix
 *                            ('escalated_by_review', 'reopen_cap_exhausted',
 *                             'budget_exhausted', 'verdict_misconfigured',
 *                             'stage_max_attempts_exceeded',
 *                             'budget_guard_denied', adapter `errorKind`)
 *   - status = 'cancelled' → run.lastError carries cancel reason
 */
export interface RunnerHooks {
  /** Fired right after the run row's status flips from `pending` to
   *  `running` and before any stage spawn. The first observable
   *  signal that a run is now actively dispatching. */
  onRunStart?(run: WorkflowRunRow): void | Promise<void>;
  /** Fired right after a stage row is created + the run row's
   *  `current_stage_id` is updated, before adapter.spawn is called.
   *  Receives the snapshot stage definition + attempt number. */
  onStageStart?(args: {
    run: WorkflowRunRow;
    stage: WorkflowStage;
    stageRow: WorkflowRunStageRow;
    attempt: number;
  }): void | Promise<void>;
  /** Fired right after a stage row's terminal status update. The
   *  next stage (or run terminal) hasn't fired yet. Useful for
   *  posting Mo comments at the boundary between fix and review. */
  onStageEnd?(args: {
    run: WorkflowRunRow;
    stage: WorkflowStage;
    stageRow: WorkflowRunStageRow;
  }): void | Promise<void>;
  /** Fired right after the run row reaches a terminal status. The
   *  callback receives the final row (status / lastError / finishedAt
   *  populated). */
  onRunTerminal?(run: WorkflowRunRow): void | Promise<void>;
}

export interface TicketContext {
  id: string;
  title: string;
  body: string;
  /** Pre-formatted recent comments block; runner does NOT format —
   *  callers shape it for their UI / domain. */
  recentComments?: string;
  /** Free-form extension shape for L4 — additional fields available
   *  via `{{ticket.<key>}}`. */
  [key: string]: unknown;
}

export interface RunHandle {
  readonly runId: string;
  /** Resolves with the terminal `WorkflowRunRow` once the run reaches
   *  a terminal status (`done` / `failed` / `cancelled`). Never
   *  rejects — failure modes are reflected in the row's `status` +
   *  `lastError`. */
  awaitTerminal(): Promise<WorkflowRunRow>;
  /** Idempotent. Flips `cancel_requested` on the run, cancels the
   *  in-flight adapter handle (if any). The dispatch loop observes
   *  the flag between stages and on the next adapter terminal event;
   *  the resolved terminal row will have `status='cancelled'`. */
  cancel(reason?: string): Promise<void>;
  /** True iff this handle attached to an existing in-flight run via
   *  the `createRun` dedupe path rather than starting a fresh one.
   *  Callers can branch on this for UI ("joined existing run"). */
  readonly deduped: boolean;
}

/**
 * Internal per-run bookkeeping the runner keeps in `states`. Exported
 * so per-stage executor modules (extracted in later refactor stages)
 * can take an `InternalRunState` argument without a circular dep back
 * through `runner.ts`. Not part of the public runner API.
 */
export interface InternalRunState {
  runId: string;
  currentAdapterHandle: AgentHandle | null;
  cancelReason: string | null;
  /** Per-stage rendered context keyed by `stage.id`. Built up as
   *  stages complete; consumed by subsequent stages' prompt templates
   *  via `{{stages.<id>.output.<key>}}`. The shape is
   *  `{[stageId]: {output: {...stageResult}}}` so templates can opt
   *  into structured access without flattening into the stage's
   *  bookkeeping fields. */
  stageOutputs: Record<string, { output: Record<string, unknown> }>;
  /** Surface for the reopen-loop. Populated when a verdictPolicy
   *  routes the run back to an earlier stage. Templates read it as
   *  `{{reopen.reason}}` / `{{reopen.fromStageId}}`. Reset to `{}` on
   *  every regular linear advance so a stale value can't leak into
   *  the wrong stage. */
  reopenContext: Record<string, unknown>;
  hooks: RunnerHooks;
  terminalPromise: Promise<WorkflowRunRow>;
  terminalResolve: (row: WorkflowRunRow) => void;
}

/**
 * Dependency + helper bag passed to per-stage executor modules. The
 * runner builds it once per dispatch loop with concrete dispatchers
 * + helpers bound; executors stay framework-free and unit-testable.
 *
 * `runHook` / `isCancelled` / `terminate` / `fireStageEndHook` are
 * exposed as plain callbacks (bound) so executors don't need a
 * reference to the runner instance.
 *
 * Used by stage-mcp-tool-call, stage-cli-agent, stage-mo-decision,
 * stage-human-gate, stage-sink and their DAG/linear orchestrators.
 */
export interface StageExecutorContext {
  deps: WorkflowRunnerDeps;
  now: () => number;
  budgetGuard: BudgetGuard;
  mcpToolDispatcher: McpToolDispatcher;
  moStageDispatcher: MoStageDispatcher;
  humanGateHandler: HumanGateHandler;
  runHook<T>(
    label: string,
    hook: ((arg: T) => void | Promise<void>) | undefined,
    arg: T,
  ): Promise<void>;
  isCancelled(state: InternalRunState): boolean;
  terminate(
    state: InternalRunState,
    status: 'done' | 'failed' | 'cancelled',
    error: string | null,
  ): Promise<void>;
  fireStageEndHook(state: InternalRunState, stage: WorkflowStage): Promise<void>;
}

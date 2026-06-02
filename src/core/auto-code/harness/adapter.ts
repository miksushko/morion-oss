/**
 * Auto-code CLI Agent Harness — adapter contract (L1.T1, types only).
 *
 * `CliAgentAdapter` is the uniform spawn/control contract for one CLI
 * coding agent (claude / codex / pi / opencode). Implementations land
 * in L1.T3-T6.
 *
 * Architectural invariants (do NOT break in implementations):
 *
 *   1. **Runtime-agnostic.** The adapter knows NOTHING about Morion
 *      workflow_runs / kanban / mo_spend_ledger / Mo. It only knows
 *      how to spawn one CLI binary, parse its stdout, and surface a
 *      uniform `CliAgentEvent` stream. All higher-level orchestration
 *      lives in L2+ (workflow runner) and L3+ (per-ticket chat,
 *      ask_user routing). This layer compiles + tests against zero
 *      Morion-specific dependencies.
 *
 *   2. **Adapter instances are stateless.** Per-spawn state lives on
 *      the `AgentHandle` returned by `spawn()`. One adapter instance
 *      MAY back many concurrent spawns. Implementations MUST NOT
 *      cache per-run state on `this`.
 *
 *   3. **Errors during spawn reject the `spawn()` promise.** Errors
 *      during the run are emitted as terminal `error` events on
 *      `handle.events`. The error TYPE on rejection mirrors the
 *      `errorKind` that would have been emitted, so calling code can
 *      use the same machine-readable kind in either path.
 *
 *   4. **`cancel()` is idempotent.** Second + subsequent calls
 *      resolve to the same final state. `cancel()` always resolves;
 *      it never throws. The terminal `error { errorKind: 'killed' }`
 *      event is emitted regardless.
 *
 *   5. **`resume()` may throw `AgentResumeUnsupportedError`** for
 *      adapters whose underlying CLI cannot resume an existing
 *      session (codex 0.1.x). Callers must catch and decide policy
 *      (typically: switch to a fresh `spawn()` with the conversation
 *      context re-included, or fail the workflow_run with a clear
 *      error message).
 *
 *   6. **No process leaks.** Implementations MUST integrate with
 *      L1.T7 process safety (orphan-watch + lockfile + SIGTERM chain)
 *      so a crash of our sidecar doesn't leave zombie agent
 *      processes. See `tasks/lessons.md` "Disable Mo Concierge +
 *      zombie sidecar prevention" for the reference incident.
 *
 * Design doc: Morion note `01KR5TMKE9GZGXTQ2BCTWCXVD5` §3.
 */

import type { AgentName, CliAgentEvent } from './events.js';

// ---------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------

export interface CliAgentAdapter {
  /** Stable adapter name. Matches `SessionStartEvent.agent` of every
   *  event the adapter emits. */
  readonly name: AgentName;

  /**
   * Spawn the agent CLI as a child process.
   *
   * Throws on:
   *   - `AgentBinaryNotFoundError` — CLI binary missing on PATH and
   *     no override env var set.
   *   - `AgentSpawnError` — child process couldn't start (bad cwd,
   *     permission denied, EMFILE, etc.).
   *   - `AgentRequiredPackageMissingError` — adapter requires extra
   *     packages (e.g. `pi-mcp-adapter`) that are not installed and
   *     auto-install is disabled.
   *
   * Returns: a handle whose `events` AsyncIterable starts producing
   * events immediately. Consumers MAY iterate or ignore — events
   * still drive transcript persistence (L1.T8) via an internal
   * subscription, so dropping the iterator does NOT stop the run.
   */
  spawn(opts: SpawnOptions): Promise<AgentHandle>;
}

// ---------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------

export interface AgentHandle {
  /** Adapter that produced this handle. Matches the `agent` field
   *  on every event in the stream. */
  readonly adapter: AgentName;

  /** Agent-side session id. Available immediately after spawn (the
   *  adapter generates one if `SpawnOptions.sessionId` was omitted).
   *  Used by `resume()` to re-attach after a crash / pause. */
  readonly sessionId: string;

  /** Process id of the spawned CLI. Surfaces for L1.T7 orphan-watch
   *  / SIGTERM-on-toggle-off. May be `null` very briefly during
   *  spawn handshake; non-null once the first event arrives. */
  readonly pid: number | null;

  /**
   * Resolves when the child process is fully reaped (NOT just when
   * the terminal event arrives in the stream).
   *
   * For streaming adapters (pi, opencode), `events` may close
   * BEFORE the child exits — e.g. pi emits `agent_end` then hangs.
   * Consumers that need full lifecycle cleanup (resume in same
   * worktree, retention pruning, lockfile release) MUST await
   * `exited`, not rely on `for await (const ev of events)` ending.
   *
   * Idempotent: multiple awaiters all resolve once the child closes.
   * Never rejects — even kill / timeout paths surface as terminal
   * `error` events on the stream and then resolve `exited`.
   */
  readonly exited: Promise<void>;

  /**
   * Async event stream. Iterate with `for await (const ev of
   * handle.events)`. The stream closes cleanly after exactly one
   * terminal event (`result` or `error`). Multiple iterations of
   * the same `events` property are allowed (events are tee'd to
   * each consumer); consumers SHOULD start iterating before the
   * first event arrives to avoid losing prelude events.
   */
  readonly events: AsyncIterable<CliAgentEvent>;

  /**
   * Request graceful cancellation.
   *
   * Sequence:
   *   1. Emit a `cancel_requested` event with `reason`.
   *   2. Send SIGTERM to the child.
   *   3. Wait up to 2s for clean exit.
   *   4. Send SIGKILL on timeout.
   *   5. Wait for process reap.
   *   6. Emit terminal `error { errorKind: 'killed' }`.
   *   7. Resolve.
   *
   * Idempotent. Never throws — failures during the kill chain are
   * surfaced via the terminal event, not an exception.
   *
   * @param reason Free-text reason persisted on the
   *   `cancel_requested` event. Suggested values:
   *   `user_toggle_off`, `timeout`, `workflow_paused`,
   *   `parent_handle_cancel`. Defaults to `parent_handle_cancel`.
   */
  cancel(reason?: string): Promise<void>;

  /**
   * Resume an earlier session by re-spawning the underlying CLI
   * with its `--resume <sessionId>` flag and an optional
   * `injectedMessage` to inject into the conversation as the next
   * user turn.
   *
   * Implementation note for L3: this is the path used after
   * `ask_user` resolution — the agent process was killed when the
   * stage entered `paused_ask_user`, and we resume with the user's
   * answer injected as the next message.
   *
   * Throws:
   *   - `AgentResumeUnsupportedError` for adapters whose CLI cannot
   *     resume (codex 0.1.x). Callers must handle this explicitly.
   *
   * @returns A NEW handle for the resumed run. The original handle
   *   stays in its terminal state (events stream remains closed,
   *   `getCost()` still returns the original cost).
   */
  resume(injectedMessage?: string): Promise<AgentHandle>;

  /**
   * Cumulative USD cost observed so far. Updated as cost-bearing
   * events arrive. After the terminal `result` event, returns the
   * final cost. Before the spawn handshake completes, returns 0.
   *
   * For agents that don't expose cost (codex 0.1.x), always 0
   * (informational — see adapter docs). The workflow runner (L2)
   * records cost via `mo_spend_ledger` from the terminal event,
   * not by polling this method.
   */
  getCost(): number;
}

// ---------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------

/**
 * Inputs to `CliAgentAdapter.spawn()`.
 *
 * Kept intentionally small + agent-agnostic. Per-agent configuration
 * (specific provider, model name, package gates) goes via the
 * `agentConfig` field — adapter implementations narrow it to their
 * own typed config and validate at runtime.
 */
export interface SpawnOptions {
  /** The user-facing prompt to send to the agent. */
  prompt: string;

  /** Working directory for the child process. Adapters do NOT
   *  create this — caller is responsible (typically a worktree set
   *  up by L2 workflow runner). Must exist and be writable. */
  cwd: string;

  /** Optional pre-allocated session id. When omitted, the adapter
   *  generates a UUID. Pass an explicit id when the caller (e.g.
   *  L2 workflow runner) wants to track the session externally
   *  before spawn completes. */
  sessionId?: string;

  /** Resume mode (Phase 6 V2 hotfix, 2026-05-13). When set, the
   *  adapter spawns the underlying CLI in resume mode against this
   *  prior session id (claude `--resume <id>` / pi `--session <id>`
   *  / opencode equivalent), with `prompt` injected as the next
   *  user turn in the existing conversation rather than as the
   *  opening message of a fresh session. Used by the workflow
   *  runner when re-entering a cli_agent stage after a human_gate
   *  loop-back so the agent retains memory of its prior questions
   *  and the user's reply lands as the natural next turn.
   *
   *  Adapters whose CLI lacks resume (codex 0.1.x) MUST throw
   *  `AgentResumeUnsupportedError` when this option is set. The
   *  caller catches and falls back to fresh spawn. */
  resumeSessionId?: string;

  /** Canonical tool allowlist using claude-style names (`Read`,
   *  `Write`, `Edit`, `Glob`, `Grep`, `Bash`). Adapters map these
   *  to their native vocabulary (pi → `read,write,edit,find,grep,
   *  bash`). Omit to use the adapter's default policy. */
  allowedTools?: readonly string[];

  /** Model name in vendor-native form (`gpt-5`, `qwen-coder`,
   *  `claude-opus-4-7`, etc.). Omit to use the agent's default
   *  (which the adapter's underlying CLI picks). */
  model?: string;

  /** Provider — which API/auth path the underlying CLI uses to talk
   *  to the model. Examples: 'anthropic' (Claude direct), 'openai'
   *  (Codex direct / gpt-5 family), 'openrouter', 'groq', 'ollama'.
   *  Omit to use the adapter default (claude → OAuth Max; codex →
   *  `~/.codex/auth.json`; pi → folder OpenRouter setting; opencode →
   *  folder default). Surfaced from Editor Model v2 cli_agent stage
   *  fields by the workflow runner (Phase 4); adapters narrow it to
   *  their own CLI flag where applicable, or ignore otherwise. */
  provider?: string;

  /** Level — quality/effort knob whose semantics depend on `adapter`:
   *    - claude: 'Default' | 'Think' | 'ThinkHard' | 'ThinkHarder'
   *              | 'Ultrathink' (extended-thinking budgets)
   *    - codex:  'Default' | 'Low' | 'Medium' | 'High' (reasoning_effort)
   *    - pi / opencode: 'Default' only
   *  Surfaced from Editor Model v2 cli_agent stage fields by the
   *  workflow runner (Phase 4). Adapters that don't yet wire it
   *  through to their CLI ignore the field — no behaviour change. */
  level?: string;

  /** Soft budget cap in USD. Adapters that support a CLI budget
   *  flag (claude `--max-budget-usd`) pass this through; adapters
   *  that don't (codex / pi / opencode) ignore it — the workflow
   *  runner enforces budgets at its own level via cost-event
   *  tracking from the terminal `result` event. */
  maxBudgetUsd?: number;

  /** Wall-clock timeout in ms. Default 30 minutes (1_800_000).
   *  After expiry the adapter calls `cancel('timeout')` internally
   *  and the stream terminates with
   *  `error { errorKind: 'timeout', recoverable: false }`. */
  timeoutMs?: number;

  /** Extra environment variables, merged on top of `process.env`.
   *  Adapters MAY add their own (e.g. process-safety env vars in
   *  L1.T7 like `MORION_HARNESS_PARENT_PID`). User-supplied vars
   *  take precedence over adapter defaults BUT never override
   *  Morion-reserved keys (the `MORION_HARNESS_*` namespace —
   *  documented in L1.T7). */
  env?: Readonly<Record<string, string>>;

  /** Optional cancellation signal. When fired, equivalent to
   *  calling `handle.cancel('external_signal')`. Convenient for
   *  callers that already have an AbortController scoped around a
   *  larger operation. */
  signal?: AbortSignal;

  /** Adapter-specific extra config. Adapter implementations narrow
   *  this to their own typed shape (e.g. PiAdapter expects
   *  `{ provider, requiredPackages? }`). Adapters MUST validate
   *  at runtime and throw `AgentSpawnError` on bad shape. */
  agentConfig?: Readonly<Record<string, unknown>>;

  /** When set, every emitted `CliAgentEvent` is persisted to
   *  `<transcriptDir>/<sessionId>.jsonl` parallel to the in-memory
   *  event stream. The file is ready for replay via
   *  `readTranscript()` after `handle.exited` resolves. Used by the
   *  L2 workflow runner UI drawer + L3 retention pruning.
   *
   *  Caller is responsible for cleanup (delete old transcripts
   *  per retention policy). The harness only writes; never deletes
   *  past files. */
  transcriptDir?: string;
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

/**
 * Base class for every harness error.
 *
 * Carries a stable `errorKind` matching the corresponding
 * `ErrorEvent.errorKind` so the same machine-readable code surfaces
 * whether the failure happens during spawn (thrown) or during a run
 * (event-emitted). Calling code can switch on `errorKind` once and
 * handle both paths uniformly.
 */
export class AgentHarnessError extends Error {
  constructor(
    public readonly errorKind: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentHarnessError';
  }
}

/** CLI binary missing on PATH and no override env var set. */
export class AgentBinaryNotFoundError extends AgentHarnessError {
  constructor(
    public readonly agent: AgentName,
    public readonly lookedAt: readonly string[],
    cause?: unknown,
  ) {
    super(
      'binary_not_found',
      `${agent} binary not found. Looked at: ${lookedAt.join(', ')}.`,
      cause,
    );
    this.name = 'AgentBinaryNotFoundError';
  }
}

/** Child process couldn't start (bad cwd, permission denied,
 *  EMFILE, etc.). The original syscall error is in `cause`. */
export class AgentSpawnError extends AgentHarnessError {
  constructor(message: string, cause?: unknown) {
    super('spawn_failed', message, cause);
    this.name = 'AgentSpawnError';
  }
}

/**
 * Thrown by `AgentHandle.resume()` for adapters whose underlying
 * CLI does not support resuming a previous session (codex 0.1.x).
 *
 * Callers must catch this and either:
 *   - Switch to a fresh `spawn()` with the conversation context
 *     re-included in the prompt, OR
 *   - Mark the workflow_run as failed with a clear error message.
 */
export class AgentResumeUnsupportedError extends AgentHarnessError {
  constructor(
    public readonly agent: AgentName,
    hint?: string,
  ) {
    super(
      'agent_resume_unsupported',
      `${agent} adapter does not support session resume.${hint ? ' ' + hint : ''}`,
    );
    this.name = 'AgentResumeUnsupportedError';
  }
}

/**
 * Thrown by adapters whose CLI requires extra packages to be
 * installed for the requested operation (e.g. PiAdapter needing
 * `pi-mcp-adapter` for ask_user MCP callbacks in L3).
 *
 * Carries the install command in `installHint` so callers can
 * surface it directly to the user — adapters MUST NOT auto-install
 * unless explicitly opted in (auto-install policy is owned by L4
 * onboarding flow, not this layer).
 */
export class AgentRequiredPackageMissingError extends AgentHarnessError {
  constructor(
    public readonly agent: AgentName,
    public readonly missingPackages: readonly string[],
    public readonly installHint: string,
  ) {
    super(
      'required_package_missing',
      `${agent} adapter requires packages not installed: ${missingPackages.join(', ')}. Install: ${installHint}`,
    );
    this.name = 'AgentRequiredPackageMissingError';
  }
}

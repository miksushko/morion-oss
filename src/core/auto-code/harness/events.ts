/**
 * Auto-code CLI Agent Harness — event taxonomy (L1.T1, types only).
 *
 * `CliAgentEvent` is the unified event stream emitted by every CLI
 * agent adapter (claude / codex / pi / opencode). One in-memory shape,
 * one transcript JSONL line shape, one UI rendering surface — adapters
 * normalise their native streaming output (claude `--output-format
 * json`, codex stdout JSON, pi `--mode json` LF-JSONL, opencode
 * `--format json`) into this taxonomy.
 *
 * Inspired by harness.lol's NDJSON event schema (SessionStart /
 * TextDelta / Message / ToolStart / ToolEnd / Result / Error) and
 * extended with `cancel_requested` so the orchestrator can render
 * "cancelling…" UI before the terminal event arrives.
 *
 * Module scope: type definitions only. Runtime parsing + Zod schemas +
 * `parseEventLine` helper land in L1.T2 (`events-runtime.ts` or
 * appended here — TBD by T2).
 *
 * Stream invariants (adapter implementations MUST hold):
 *   1. Every event carries `kind` + `timestamp` (epoch ms).
 *   2. Events arrive in observation order. Consumers may rely on this.
 *   3. Exactly one terminal event closes the stream: `result` (clean
 *      finish) OR `error` (failure of any kind, including timeout +
 *      cancel-induced kill). After the terminal event the
 *      `AsyncIterable` returned by `AgentHandle.events` ends.
 *   4. `cancel_requested` MAY appear before the terminal event — it
 *      announces intent. The terminal event still follows (typically
 *      `error { errorKind: 'killed' }`).
 *   5. `session_start` is the FIRST non-discardable event. Adapters
 *      may emit `text_delta` before `session_start` for CLIs that
 *      stream banner text — consumers SHOULD ignore prelude deltas.
 */

/** Canonical agent name. Matches `SessionStartEvent.agent` and the
 *  adapter implementation's `name` field. v1 supports four agents;
 *  add to the union when L7 ships further backends. */
export type AgentName = 'claude' | 'codex' | 'pi' | 'opencode';

/** Common base for every event. Adapters must populate `timestamp`
 *  with `Date.now()` at observation time (NOT at parse time — keep it
 *  faithful to the underlying CLI). */
export interface BaseEvent {
  /** Epoch milliseconds when the adapter observed the event. */
  timestamp: number;
}

/** Discriminator union for every event the harness can emit. */
export type CliAgentEvent =
  | SessionStartEvent
  | TextDeltaEvent
  | MessageEvent
  | ToolStartEvent
  | ToolEndEvent
  | ResultEvent
  | ErrorEvent
  | CancelRequestedEvent;

/** Run started. First non-prelude event in every stream. */
export interface SessionStartEvent extends BaseEvent {
  kind: 'session_start';
  /** Agent-side session id. For claude this is the value passed via
   *  `--session-id`; pi/opencode echo their `--session` arg; codex
   *  generates its own and surfaces it in the first JSON line. Used
   *  by `AgentHandle.resume()` to re-attach after a crash / pause. */
  sessionId: string;
  /** Which adapter produced this event. Lets transcript readers
   *  filter or render per-agent without inspecting the file path. */
  agent: AgentName;
}

/** Incremental text chunk. NOT line-buffered — concatenate for full
 *  message reconstruction. Most adapters emit these between
 *  `session_start` and either a `message` or `result`. */
export interface TextDeltaEvent extends BaseEvent {
  kind: 'text_delta';
  text: string;
}

/** Fully-buffered message from one of the conversation roles. */
export interface MessageEvent extends BaseEvent {
  kind: 'message';
  /** Speaker. `assistant` is the agent itself. `tool` narrates a tool
   *  result back into the conversation. `user` surfaces when the
   *  agent echoes our prompt back. `system` carries instructions /
   *  policy notes from the agent's harness. */
  role: 'assistant' | 'tool' | 'user' | 'system';
  /** Plain-text content. */
  content: string;
}

/** Agent invoked a tool. `toolName` stays in the agent's NATIVE
 *  vocabulary — we don't translate to a canonical taxonomy because
 *  transcripts must faithfully represent what the agent did. */
export interface ToolStartEvent extends BaseEvent {
  kind: 'tool_start';
  toolName: string;
  /** Tool arguments as the agent supplied them. Free-form JSON;
   *  optional because some tools take no arguments (e.g. a "list
   *  current directory" with no params). */
  args?: unknown;
}

/** Tool call completed. Pairs with the most recent `tool_start` of
 *  matching `toolName` (no explicit pairing id — tools are sequential
 *  per the agent's CLI contracts in scope). */
export interface ToolEndEvent extends BaseEvent {
  kind: 'tool_end';
  toolName: string;
  /** Tool result. Free-form JSON; optional because some tools have
   *  void return semantics (success implied by absence of error). */
  result?: unknown;
  durationMs: number;
}

/** Terminal event for clean completion (or budget-capped stop —
 *  distinguish via `terminalReason`). */
export interface ResultEvent extends BaseEvent {
  kind: 'result';
  /** Process exit code. 0 = success. Adapters set this from the
   *  child process exit code, NOT from any in-stream "result" field
   *  the CLI may emit. */
  exitCode: number;
  /** Final result text from the agent. May be empty if the agent
   *  never produced a result (rare — usually paired with non-zero
   *  exit code routed through `ErrorEvent`). */
  summary: string;
  /** Cumulative USD cost reported by the agent. Adapters that don't
   *  expose cost (codex 0.1.x) report 0 with a JSDoc note that the
   *  number is informational. Workflow runner records this in the
   *  `mo_spend_ledger` (L2). */
  costUsd: number;
  /** Why the agent stopped without an error.
   *    - `completed` — agent finished its task cleanly (default for
   *      adapters without a budget concept).
   *    - `budget` — agent stopped because the per-stage budget cap
   *      (`SpawnOptions.maxBudgetUsd`) was hit. The work may be
   *      incomplete; the workflow runner (L2) decides retry policy
   *      from this discriminator (NOT from comparing `costUsd` to
   *      cap, which is approximate due to rounding). */
  terminalReason: 'completed' | 'budget';
}

/** Terminal event for any failure path. */
export interface ErrorEvent extends BaseEvent {
  kind: 'error';
  /** Stable machine-readable error category. Adapters define their
   *  own kinds; established values include:
   *    - `spawn_failed` — child process couldn't start
   *    - `timeout` — wall-clock timeout fired
   *    - `killed` — explicit cancel produced SIGTERM/SIGKILL
   *    - `parse_failed` — adapter couldn't decode CLI output
   *    - `agent_resume_unsupported` — `resume()` on an agent that
   *      lacks `--resume` (codex 0.1.x)
   *    - `binary_not_found` — CLI binary missing on PATH
   *    - `required_package_missing` — adapter needs an additional
   *      package (e.g. `pi-mcp-adapter`)
   *    - `codex_ink_crash` — codex 0.1.x Ink-rawmode failure mode
   *    - `non_zero_exit` — generic non-zero exit without a more
   *      specific signal */
  errorKind: string;
  /** Human-readable message suitable for surfacing in UI. */
  message: string;
  /** Whether the orchestrator can sensibly retry. Examples:
   *    - `codex_ink_crash` → recoverable=true (claude-fallback).
   *    - `spawn_failed` / `binary_not_found` → recoverable=false. */
  recoverable: boolean;
}

/** Cancel intent signalled. Emitted by `AgentHandle.cancel()` BEFORE
 *  the SIGTERM/SIGKILL chain so consumers can render a "cancelling…"
 *  state. The terminal event (`error { errorKind: 'killed' }`)
 *  follows once the process is reaped. */
export interface CancelRequestedEvent extends BaseEvent {
  kind: 'cancel_requested';
  /** Free-text reason persisted in transcripts. Suggested values:
   *  `user_toggle_off`, `timeout`, `workflow_paused`,
   *  `parent_handle_cancel`, `external_signal`. */
  reason: string;
}

// ---------------------------------------------------------------------
// Type guards — light, stable, useful in adapter implementations and
// in workflow runner code that walks an event stream. Implementations
// stay in this file because they are pure type narrowings.
// ---------------------------------------------------------------------

export function isTerminalEvent(
  ev: CliAgentEvent,
): ev is ResultEvent | ErrorEvent {
  return ev.kind === 'result' || ev.kind === 'error';
}

export function isResult(ev: CliAgentEvent): ev is ResultEvent {
  return ev.kind === 'result';
}

export function isError(ev: CliAgentEvent): ev is ErrorEvent {
  return ev.kind === 'error';
}

export function isSessionStart(ev: CliAgentEvent): ev is SessionStartEvent {
  return ev.kind === 'session_start';
}

/**
 * Auto-code CLI Agent Harness — `AbstractAgentHandle` types + constants.
 *
 * Pure types + numeric constants extracted from `abstract-handle.ts`
 * (2026-05-16, ticket `01KRQYTZACVBNQ5RAWRR5PZPQ8`). The base class itself
 * stays in `abstract-handle.ts` as a cohesive state machine; everything
 * stateless lives here so adapters can import the params shape without
 * pulling the class.
 */

import type { SpawnOptions } from './adapter.js';

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const SIGTERM_GRACE_MS = 2_000;
export const STDERR_TAIL_BYTES = 16 * 1024;

/** Constructor input for an AbstractAgentHandle. Carries everything
 *  the base lifecycle needs; subclasses extend with their own
 *  fields when needed. */
export interface AbstractHandleParams {
  /** Resolved binary path. Subclass + adapter resolve this before
   *  constructing the handle. */
  binPath: string;
  /** Pre-allocated session id (caller-supplied or adapter-generated
   *  via `generateSessionId()`). */
  sessionId: string;
  /** Agent identity — populates `SessionStartEvent.agent` and
   *  `AgentHandle.adapter`. Also used in error messages so the
   *  user can tell which agent failed. */
  agent: import('./events.js').AgentName;
  /** Caller's prompt (after Mustache expansion if applicable). */
  prompt: string;
  /** Working directory (caller's responsibility — the harness
   *  doesn't create worktrees). */
  cwd: string;
  /** Wall-clock timeout (ms). Subclass-supplied default applied
   *  before this struct reaches the base. */
  timeoutMs: number;
  /** Caller-supplied env vars merged on top of `process.env`.
   *  `MORION_HARNESS_*` keys are stripped (reserved for L1.T7
   *  process-safety wrap). */
  env?: Readonly<Record<string, string>>;
  /** External cancellation signal. Equivalent to calling
   *  `handle.cancel('external_signal')` when fired. */
  signal?: AbortSignal;

  /** When set, the handle persists every emitted `CliAgentEvent`
   *  to `<transcriptDir>/<runId>.jsonl` parallel to the in-memory
   *  broadcast. Used by L2 UI drawer + L3 retention. Omit during
   *  unit tests if persistence is not under test. */
  transcriptDir?: string;
}

/** Common shape adapters typically pass through to subclass-specific
 *  HandleParams — kept here to avoid scattering field definitions
 *  across each adapter. Adapters not using a particular field
 *  simply omit it from their own subclass param type. */
export type ForwardedSpawnOptions = Pick<
  SpawnOptions,
  | 'allowedTools'
  | 'model'
  | 'maxBudgetUsd'
  | 'agentConfig'
>;

/**
 * Module-level helpers for `WorkflowRunner`. Framework-free and side
 * effect-free (modulo `setTimeout` in `sleep`) — extracted out of
 * `runner.ts` so they can be unit-tested without spinning the runner
 * + the repository + adapter factory.
 *
 * Stage 1 of the runner.ts decomposition (ticket
 * 01KRJYYZ3YE57V1PM06ACBDS0T).
 */

import type {
  CliAgentEvent,
  ErrorEvent,
  ResultEvent,
} from '../harness/events.js';
import { isTerminalEvent } from '../harness/events.js';
import type { WorkflowEdge } from './types/index.js';

/**
 * Error kinds that should activate the stage's `fallbackAgent` retry
 * when surfaced from spawn() as a thrown AgentHarnessError. Aligned
 * with the ErrorEvent.recoverable semantics from L1 — the same kinds
 * arrive as either path (thrown vs emitted) depending on whether the
 * underlying CLI failed before or after the spawn handshake.
 */
export function isRecoverableErrorKind(kind: unknown): boolean {
  return (
    typeof kind === 'string' &&
    (kind === 'binary_not_found' ||
      kind === 'required_package_missing' ||
      kind === 'codex_ink_crash')
  );
}

/**
 * Drain an adapter event stream until the terminal `result` / `error`
 * event arrives. Optional `onSessionId` callback fires when the
 * adapter emits its `session_start` event so the caller can persist
 * the CLI's internal session id alongside its own UUID.
 *
 * If the stream closes without a terminal event, synthesise an
 * `error` event with `errorKind='stream_closed_without_terminal'` so
 * the caller always observes one terminal envelope.
 *
 * Phase 6 V2 hotfix (2026-05-13) — capture authoritative session ids
 * as they arrive. Pi (and Opencode) emit a `session_start` event with
 * the CLI's internal session id which differs from the caller-side
 * UUID stored on the handle. The CLI requires its OWN id on
 * `--session` resume; passing our UUID errors with "No session found
 * matching ...". The runner persists the authoritative id to the
 * stage row so attempt N+1's resume lookup picks it up.
 */
export async function consumeUntilTerminal(
  events: AsyncIterable<CliAgentEvent>,
  onSessionId?: (id: string) => void,
): Promise<ResultEvent | ErrorEvent> {
  for await (const ev of events) {
    if (ev.kind === 'session_start' && onSessionId) {
      onSessionId(ev.sessionId);
    }
    if (isTerminalEvent(ev)) return ev;
  }
  return {
    kind: 'error',
    errorKind: 'stream_closed_without_terminal',
    message: 'event stream closed without emitting result or error',
    recoverable: false,
    timestamp: Date.now(),
  };
}

/** Promise wrapper around `setTimeout`. Used by the `awaitTerminal`
 *  polling fallback for cross-process attach. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Phase 4 DAG walker — resolve the outbound edge from `fromId` whose
 * label matches `label`. Returns the target stage id or null when no
 * edge matches.
 *
 * Pure given the edges. `cli_agent` + `mcp_tool_call` stages have a
 * single `success` outbound; `mo_stage` nodes label outbounds with
 * their `branches[].label`; sinks have no outbounds.
 */
export function findOutboundByLabel(
  edges: readonly WorkflowEdge[],
  fromId: string,
  label: string,
): string | null {
  for (const e of edges) {
    if (e.from === fromId && e.on === label) return e.to;
  }
  return null;
}

/**
 * Reopen-reason header rendered into the reopened stage's `{{reopen.reason}}`
 * placeholder. Wraps the reviewer's free-text feedback in a banner so
 * the LLM has unambiguous context that this is a re-attempt + what to
 * fix.
 */
export function formatReopenReason(
  reviewerReason: string,
  fromStageId: string,
): string {
  const reason = reviewerReason.trim() || '(no reason provided by the reviewer)';
  return [
    `--- Previous reviewer feedback (from "${fromStageId}" stage) ---`,
    reason,
    '',
    'Address the feedback above and try again.',
  ].join('\n');
}

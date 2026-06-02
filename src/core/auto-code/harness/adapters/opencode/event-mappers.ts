/**
 * Pure mapper for opencode's `--format json` events into the unified
 * `CliAgentEvent` stream. Testable in isolation. Extracted from
 * `../opencode.ts` (2026-05-16, mirror of codex split).
 */

import type { CliAgentEvent } from '../../events.js';

export interface OpencodeEvent {
  type?: string;
  [k: string]: unknown;
}

/**
 * Mapper for opencode's `--format json` events.
 *
 * Real schema (verified against opencode CLI documentation +
 * [takopi cheatsheet](https://takopi.dev/reference/runners/opencode/stream-json-cheatsheet/)
 * 2026-05-09): every event has top-level `type` + `timestamp` +
 * `sessionID` (camelCase) and a nested `part` with type-specific
 * fields. Five event types in production:
 *
 *   - `step_start`  — beginning of a processing step. Carries
 *     `sessionID` we use for resume.
 *   - `tool_use`    — tool execution completed. `part.tool` is the
 *     tool name, `part.state.input` / `part.state.output` are
 *     args/result, `part.state.time.{start,end}` give duration.
 *   - `text`        — model-generated text. `part.text` is the
 *     content. We map to `text_delta` (incremental).
 *   - `step_finish` — processing step finished. `part.cost` (USD)
 *     + `part.tokens` aggregates. We treat the FIRST `step_finish`
 *     with `part.reason === 'stop'` as the run's terminal `result`
 *     event; cumulative cost from all `step_finish` events.
 *   - `error`       — session error. Top-level `error.name` /
 *     `error.data` give details. Maps to terminal error event.
 *
 * Codex T10 review P1 fix: pre-fix mapper accepted plausible names
 * (`session.created`, `tool.start`, `complete`) that opencode does
 * NOT actually emit — real runs would drop every event and fall
 * back to stdout-as-summary. Now the mapper matches the real names.
 *
 * The mapper is still tolerant of unknown types (returns null →
 * adapter drops the line silently) so future opencode versions
 * adding new types don't crash the parser.
 *
 * Exported for unit testing.
 */
export function mapOpencodeEventToHarness(
  raw: OpencodeEvent,
  // Kept in the signature for API parity with `mapPiEventToHarness`
  // (PiAdapter needs cross-event timestamp tracking for tool
  // durationMs since pi splits start/end into two events). Opencode
  // emits ONE `tool_use` event with `part.state.time.{start,end}`
  // already inline, so the map isn't needed here — but the shared
  // signature lets future refactor combine the two mappers without
  // breaking either's caller. The underscore prefix avoids the TS
  // unused-param error.
  _toolStartTimestamps: Map<string, number>,
): CliAgentEvent | null {
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!type) return null;
  const now = Date.now();
  const part = raw.part as Record<string, unknown> | undefined;

  // step_start — first event in every run, carries authoritative
  // sessionID. opencode uses camelCase `sessionID`.
  if (type === 'step_start') {
    const id =
      typeof raw.sessionID === 'string'
        ? raw.sessionID
        : typeof raw.sessionId === 'string'
          ? raw.sessionId
          : null;
    if (!id) return null;
    return {
      kind: 'session_start',
      sessionId: id,
      agent: 'opencode',
      timestamp: now,
    };
  }

  // tool_use — emitted ONCE when a tool finishes (start+end combined).
  // Real shape: part.tool, part.state.{status, input, output, time}.
  // We synthesize TWO harness events (tool_start + tool_end) so
  // consumers get the timeline. durationMs from part.state.time.
  if (type === 'tool_use' && part) {
    const toolName =
      typeof part.tool === 'string' ? part.tool : null;
    const state = part.state as Record<string, unknown> | undefined;
    if (!toolName || !state) return null;
    // Only emit on completed status (opencode also emits running
    // states — those are intermediate updates we drop).
    if (state.status !== 'completed') return null;
    // Compute durationMs from part.state.time if available.
    const time = state.time as Record<string, unknown> | undefined;
    const startTs =
      time && typeof time.start === 'number' ? time.start : null;
    const endTs = time && typeof time.end === 'number' ? time.end : null;
    const durationMs =
      startTs !== null && endTs !== null ? endTs - startTs : 0;
    // Returning two events from one call is awkward — emit tool_end
    // only (start+end semantics merged at this layer; consumers that
    // need timeline can pair with our own events). Mark with
    // computed durationMs so UIs can render runtime even though we
    // didn't see a paired start.
    return {
      kind: 'tool_end',
      toolName,
      result: state.output,
      durationMs,
      timestamp: now,
    };
  }

  // text — model-generated text. opencode emits these progressively
  // as the model streams. Map to text_delta for live UI rendering.
  if (type === 'text' && part) {
    const text = typeof part.text === 'string' ? part.text : null;
    if (text === null) return null;
    return {
      kind: 'text_delta',
      text,
      timestamp: now,
    };
  }

  // step_finish — processing step done. Treat the first one with
  // reason==='stop' as the run terminal. Cost surfaces from
  // part.cost. (Other reasons like 'tool-calls' are intermediate
  // step boundaries and don't terminate the run.)
  if (type === 'step_finish' && part) {
    const reason = typeof part.reason === 'string' ? part.reason : null;
    const cost = typeof part.cost === 'number' ? part.cost : 0;
    // Always reflect cost; only the 'stop' reason is terminal.
    if (reason !== 'stop') {
      // Intermediate step boundary — we don't have a harness event
      // for this. Drop silently; cost is reflected on the eventual
      // 'stop' step_finish (opencode reports cumulative).
      return null;
    }
    return {
      kind: 'result',
      exitCode: 0,
      summary: '',
      costUsd: cost,
      terminalReason: 'completed',
      timestamp: now,
    };
  }

  // error — session-level failure.
  if (type === 'error') {
    const errorObj = raw.error as Record<string, unknown> | undefined;
    const message =
      errorObj && typeof errorObj === 'object'
        ? typeof (errorObj.data as Record<string, unknown> | undefined)
            ?.message === 'string'
          ? ((errorObj.data as Record<string, unknown>).message as string)
          : typeof errorObj.name === 'string'
            ? `opencode error: ${errorObj.name as string}`
            : 'opencode reported error'
        : 'opencode reported error';
    return {
      kind: 'error',
      errorKind: 'non_zero_exit',
      message,
      recoverable: false,
      timestamp: now,
    };
  }

  // Unrecognised type — silent skip (forward-compat).
  return null;
}

// `extractContent` was removed in the Codex T10 P1 schema fix — real
// opencode `text` events carry `part.text` as a plain string, not an
// array of blocks (that pattern was lifted from claude/anthropic and
// doesn't apply here). PiAdapter still needs a similar helper for its
// `message_end.message.content` shape — see `extractMessageContent`
// in pi.ts.

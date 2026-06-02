/**
 * Auto-code CLI Agent Harness — runtime parsing for CliAgentEvent
 * (L1.T2). Zod schemas matching every event type defined in
 * `events.ts`, plus the `parseEventLine` / `parseEventObject` helpers
 * adapters use when reading from a child process stdout.
 *
 * Why split from `events.ts`:
 *   - `events.ts` is a pure-type module — `import type { CliAgentEvent }`
 *     pulls zero runtime weight and zero Zod dependency.
 *   - This module is loaded only by code that actually parses input
 *     from a CLI (the adapter implementations in L1.T3-T6).
 *
 * Schema strictness:
 *   - Required fields must be present and well-typed.
 *   - Unknown extra fields are silently stripped (Zod default). This
 *     gives forward-compat with future CLI versions that add new
 *     output fields without breaking our parser.
 *   - Discriminator (`kind`) must match one of the 8 known values
 *     exactly. Unknown kinds → parse fails → consumer treats the
 *     line as garbage and continues (NOT throw).
 */

import { z } from 'zod';
import type { CliAgentEvent } from './events.js';

// ---------------------------------------------------------------------
// Per-event schemas
// ---------------------------------------------------------------------

const TimestampField = z.number().int().nonnegative();

const SessionStartSchema = z.object({
  kind: z.literal('session_start'),
  sessionId: z.string().min(1),
  agent: z.enum(['claude', 'codex', 'pi', 'opencode']),
  timestamp: TimestampField,
});

const TextDeltaSchema = z.object({
  kind: z.literal('text_delta'),
  text: z.string(),
  timestamp: TimestampField,
});

const MessageSchema = z.object({
  kind: z.literal('message'),
  role: z.enum(['assistant', 'tool', 'user', 'system']),
  content: z.string(),
  timestamp: TimestampField,
});

const ToolStartSchema = z.object({
  kind: z.literal('tool_start'),
  toolName: z.string().min(1),
  args: z.unknown(),
  timestamp: TimestampField,
});

const ToolEndSchema = z.object({
  kind: z.literal('tool_end'),
  toolName: z.string().min(1),
  result: z.unknown(),
  durationMs: z.number().nonnegative(),
  timestamp: TimestampField,
});

const ResultSchema = z.object({
  kind: z.literal('result'),
  exitCode: z.number().int(),
  summary: z.string(),
  costUsd: z.number().nonnegative(),
  terminalReason: z.enum(['completed', 'budget']),
  timestamp: TimestampField,
});

const ErrorEventSchema = z.object({
  kind: z.literal('error'),
  errorKind: z.string().min(1),
  message: z.string(),
  recoverable: z.boolean(),
  timestamp: TimestampField,
});

const CancelRequestedSchema = z.object({
  kind: z.literal('cancel_requested'),
  reason: z.string().min(1),
  timestamp: TimestampField,
});

// ---------------------------------------------------------------------
// Discriminated union — single entry point for parsing.
// ---------------------------------------------------------------------

/**
 * Zod schema for the full `CliAgentEvent` discriminated union. Use
 * `parseEventLine` / `parseEventObject` for the common adapter cases;
 * import the schema directly only when you need its `.safeParse` /
 * `.parse` API for advanced flows (e.g. workflow runner replay
 * validation in L2).
 */
export const CliAgentEventSchema = z.discriminatedUnion('kind', [
  SessionStartSchema,
  TextDeltaSchema,
  MessageSchema,
  ToolStartSchema,
  ToolEndSchema,
  ResultSchema,
  ErrorEventSchema,
  CancelRequestedSchema,
]);

// Compile-time guard: the schema's inferred output must match the
// `CliAgentEvent` type from events.ts. If a schema field drifts from
// the type, this assignment fails at `tsc` time.
const _typeCheck: CliAgentEvent = null as unknown as z.infer<
  typeof CliAgentEventSchema
>;
void _typeCheck;

// ---------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------

/**
 * Parse one line of agent stdout into a `CliAgentEvent`.
 *
 * Lenient by design — returns `null` for any input that does not yield
 * a valid event (empty/whitespace, malformed JSON, missing or
 * mistyped required fields, unknown `kind` discriminator, extra
 * fields are stripped not rejected). Adapters typically loop:
 *
 *     for (const line of stdout.split('\n')) {
 *       const ev = parseEventLine(line);
 *       if (ev) emit(ev);
 *     }
 *
 * NOT throws — silent skip on garbage matches how CLIs occasionally
 * interleave warning text with their JSON event stream. If you need
 * to surface parse failures (debug/validation), use
 * `CliAgentEventSchema.safeParse(JSON.parse(line))` directly and
 * inspect `result.error`.
 */
export function parseEventLine(line: string): CliAgentEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }

  return parseEventObject(raw);
}

/**
 * Parse an already-decoded JSON object into a `CliAgentEvent`.
 * Convenient for adapters whose CLI surfaces an array of events as a
 * single JSON document (e.g. claude `--output-format json` returns
 * one envelope, not LF-delimited lines).
 *
 * Lenient — same null-on-mismatch semantics as `parseEventLine`.
 */
export function parseEventObject(value: unknown): CliAgentEvent | null {
  const result = CliAgentEventSchema.safeParse(value);
  return result.success ? result.data : null;
}

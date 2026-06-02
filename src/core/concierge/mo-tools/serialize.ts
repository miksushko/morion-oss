import { trimEnvelopeToFit } from './trim.js';

/**
 * Slim projection + size-budget serialization for chat tool results.
 *
 * Bug context (2026-04-25): Mo's chat dispatcher previously did
 * `JSON.stringify(result).slice(0, 12_000)` at the call site. For a
 * 51-card kanban board, `tasks_list` returned `Note[]` with full
 * markdown bodies (>50KB) and the slice cut the array mid-object —
 * producing malformed JSON. The LLM salvaged whatever cleanly parsed
 * (often a single task) and reported "1 task" while 51 existed.
 *
 * Fix is two-layered:
 *   1. `projectListResult` (in `dispatch.ts`) slims `Note[]` shapes
 *      BEFORE wrapping in the envelope, so chat history never carries
 *      full bodies.
 *   2. `serializeMoToolResultForChat` (here) enforces a byte budget
 *      by replacing oversize results with a structured truncation
 *      envelope (always valid JSON, always reports `total`).
 *
 * Lessons Archive: "tool result truncation must not slice JSON".
 */

const DEFAULT_PAYLOAD_BUDGET_BYTES = 12_000;

export interface SerializedMoToolResult {
  /** JSON string fed back to the LLM as the `role='tool'` message. Always valid JSON. */
  json: string;
  /** True iff a truncation envelope replaced the original payload. */
  truncated: boolean;
  /**
   * Total row count for list-style results, regardless of how many
   * rows survived truncation. `null` for non-list shapes. Useful for
   * tests and for surfacing accurate counts in the UI.
   */
  total: number | null;
}

/**
 * Serialize a `dispatchMoTool` envelope for the chat transcript with a
 * hard byte budget. Never produces a sliced/corrupt JSON string —
 * oversize results are replaced with a structured truncation envelope
 * that reports `total` so the LLM can tell the user what's missing.
 */
export function serializeMoToolResultForChat(
  toolName: string,
  envelope: Record<string, unknown>,
  maxBytes: number = DEFAULT_PAYLOAD_BUDGET_BYTES,
): SerializedMoToolResult {
  const total = extractListTotal(toolName, envelope);
  let json = JSON.stringify(envelope);
  if (json.length <= maxBytes) {
    return { json, truncated: false, total };
  }
  const trimmed = trimEnvelopeToFit(toolName, envelope, maxBytes);
  json = JSON.stringify(trimmed);
  if (json.length > maxBytes) {
    // Belt-and-suspenders: even the trimmed envelope didn't fit.
    // Replace with a generic structured stub. NEVER slice mid-JSON.
    json = JSON.stringify({
      error: 'payload_too_large',
      tool: toolName,
      hint: 'response oversized for chat; narrow query or paginate',
    });
  }
  return { json, truncated: true, total };
}

function extractListTotal(
  toolName: string,
  env: Record<string, unknown>,
): number | null {
  if (env.ok !== true) return null;
  const data = (env as { data?: unknown }).data;
  if (Array.isArray(data)) return data.length;
  if (
    toolName === 'tasks_list' &&
    data &&
    typeof data === 'object' &&
    Array.isArray((data as { tasks?: unknown }).tasks)
  ) {
    return (data as { tasks: unknown[] }).tasks.length;
  }
  return null;
}

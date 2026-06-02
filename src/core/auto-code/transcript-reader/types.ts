/**
 * Shared types + small helpers used by both transcript parsers
 * (claude-projects + harness-runs). Extracted from
 * `../transcript-reader.ts` (2026-05-16, ticket
 * `01KRQYRTY348DAG9MM6JPMTDYR`).
 */

export type TranscriptMessageKind =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'system';

export interface TranscriptMessage {
  /** Stable id for React keys + dedup on watcher updates. Comes
   *  from the source row's `uuid` when present, else a synthetic
   *  `<line-index>` so reordering doesn't collapse rows. */
  id: string;
  kind: TranscriptMessageKind;
  /** Text body — for assistant + user this is the text portion;
   *  for tool_use it's the rendered tool name + first arg; for
   *  tool_result it's the truncated result text. */
  text: string;
  /** Tool call body when `kind === 'tool_use'` (name + input). */
  toolUse?: {
    name: string;
    input: unknown;
    id: string;
  };
  /** Tool result body when `kind === 'tool_result'`. `is_error`
   *  surfaces failures to the UI for a red marker. */
  toolResult?: {
    toolUseId: string;
    content: string;
    isError: boolean;
  };
  /** ISO timestamp from the source row, when present. */
  timestamp?: string;
}

export interface ParseTranscriptResult {
  messages: TranscriptMessage[];
  warnings: string[];
}

/** Render a tool call's first interesting input field as a short
 *  string for the drawer row label (e.g. `Read(src/foo.ts)`). Used by
 *  both the claude and harness parsers; pulled here so each parser
 *  doesn't duplicate the lookup table. */
export function summariseToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of ['file_path', 'pattern', 'command', 'query', 'path', 'url']) {
    const v = obj[key];
    if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  }
  // Fallback: stringify the keys so the user sees SOMETHING about
  // what the tool got called with.
  return Object.keys(obj).slice(0, 3).join(', ');
}

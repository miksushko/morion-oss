/**
 * Codex SDK `ThreadEvent` → unified harness `CliAgentEvent` mappers.
 *
 * Extracted from `../codex.ts` (709 LOC) so the adapter shell stays
 * under the 300-LOC cap. Pure mapping functions: no I/O, no state
 * outside the `setFinalText` callback the handle hands in so the
 * synthesized terminal `result.summary` reflects the agent's final
 * agent_message text.
 */

import type { ThreadItem } from '@openai/codex-sdk';
import type { CliAgentEvent } from '../../events.js';

/** Map an `item.started` ThreadItem to a CliAgentEvent. Returns null
 *  for items whose start has no useful representation in our taxonomy
 *  (reasoning, agent_message — those surface as `message` on completion). */
export function startedItemToEvent(
  item: ThreadItem,
  timestamp: number,
): CliAgentEvent | null {
  switch (item.type) {
    case 'command_execution':
      return {
        kind: 'tool_start',
        toolName: 'bash',
        args: { command: item.command },
        timestamp,
      };
    case 'mcp_tool_call':
      return {
        kind: 'tool_start',
        toolName: `${item.server}.${item.tool}`,
        args: item.arguments,
        timestamp,
      };
    case 'file_change':
      return {
        kind: 'tool_start',
        toolName: 'apply_patch',
        args: { changes: item.changes },
        timestamp,
      };
    case 'web_search':
      return {
        kind: 'tool_start',
        toolName: 'web_search',
        args: { query: item.query },
        timestamp,
      };
    default:
      return null;
  }
}

/** Map an `item.completed` ThreadItem to a CliAgentEvent. Side-effect:
 *  when the item is `agent_message`, the caller-provided `setFinalText`
 *  callback is invoked so the synthesized terminal `result.summary`
 *  reflects the agent's last word. */
export function completedItemToEvent(
  item: ThreadItem,
  setFinalText: (text: string) => void,
  timestamp: number,
): CliAgentEvent | null {
  switch (item.type) {
    case 'agent_message':
      // Structured output mode: `text` is the JSON string matching the
      // schema. Plain mode: `text` is natural language. Either way we
      // accumulate it for the terminal `result.summary`.
      setFinalText(item.text);
      return {
        kind: 'message',
        role: 'assistant',
        content: item.text,
        timestamp,
      };
    case 'command_execution':
      return {
        kind: 'tool_end',
        toolName: 'bash',
        result: {
          exitCode: item.exit_code ?? null,
          status: item.status,
          output: item.aggregated_output,
        },
        durationMs: 0,
        timestamp,
      };
    case 'mcp_tool_call':
      return {
        kind: 'tool_end',
        toolName: `${item.server}.${item.tool}`,
        result: item.result ?? item.error ?? { status: item.status },
        durationMs: 0,
        timestamp,
      };
    case 'file_change':
      return {
        kind: 'tool_end',
        toolName: 'apply_patch',
        result: { changes: item.changes, status: item.status },
        durationMs: 0,
        timestamp,
      };
    case 'web_search':
      return {
        kind: 'tool_end',
        toolName: 'web_search',
        result: { query: item.query },
        durationMs: 0,
        timestamp,
      };
    case 'error':
      // Non-fatal item-level error — surface as a system message in
      // the stream so transcripts capture it, but don't terminate.
      return {
        kind: 'message',
        role: 'system',
        content: `codex item error: ${item.message}`,
        timestamp,
      };
    case 'reasoning':
    case 'todo_list':
      // Not load-bearing in our taxonomy yet — skip rather than emit
      // noise. Reasoning summaries can be added later as text_delta.
      return null;
    default:
      return null;
  }
}

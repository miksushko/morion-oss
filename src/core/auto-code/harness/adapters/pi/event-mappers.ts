import type { CliAgentEvent } from '../../events.js';

/**
 * Pi → Harness event mapping (pure functions). Extracted from
 * adapters/pi.ts during the 2026-05-16 split (Morion ticket
 * 01KRQYSGYJM48WC1NJTTHZ9XNE). Exported for unit testing — the mapper
 * is the load-bearing piece that determines what consumers of the
 * harness see.
 */

/** Loose type for pi events — actual schema lives upstream and we
 *  treat unknown fields as silently dropped (Zod-like leniency). */
export interface PiEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * Convert one pi-event JSONL row into a `CliAgentEvent` (or null if
 * the event has no harness equivalent in v1, e.g. lifecycle bookkeeping).
 */
export function mapPiEventToHarness(
  raw: PiEvent,
  toolStartTimestamps: Map<string, number>,
): CliAgentEvent | null {
  const now = Date.now();
  switch (raw.type) {
    case 'session': {
      // Pi's authoritative sessionId arrives here. The base class
      // already emitted a synthetic session_start with our
      // pre-allocated id; emit a second one with pi's actual id so
      // transcripts have both available. Workflow runner consumes
      // the most recent.
      const id = typeof raw.id === 'string' ? raw.id : null;
      if (!id) return null;
      return {
        kind: 'session_start',
        sessionId: id,
        agent: 'pi',
        timestamp:
          typeof raw.timestamp === 'number' ? raw.timestamp : now,
      };
    }

    case 'tool_execution_start': {
      const toolCallId =
        typeof raw.toolCallId === 'string' ? raw.toolCallId : null;
      const toolName =
        typeof raw.toolName === 'string' ? raw.toolName : null;
      if (!toolCallId || !toolName) return null;
      toolStartTimestamps.set(toolCallId, now);
      return {
        kind: 'tool_start',
        toolName,
        args: raw.args,
        timestamp: now,
      };
    }

    case 'tool_execution_end': {
      const toolCallId =
        typeof raw.toolCallId === 'string' ? raw.toolCallId : null;
      const toolName =
        typeof raw.toolName === 'string' ? raw.toolName : null;
      if (!toolCallId || !toolName) return null;
      const startedAt = toolStartTimestamps.get(toolCallId);
      const durationMs = startedAt !== undefined ? now - startedAt : 0;
      toolStartTimestamps.delete(toolCallId);
      return {
        kind: 'tool_end',
        toolName,
        result: raw.result,
        durationMs,
        timestamp: now,
      };
    }

    case 'message_end': {
      const message = raw.message as Record<string, unknown> | undefined;
      if (!message) return null;
      const role = typeof message.role === 'string' ? message.role : null;
      if (
        role !== 'assistant' &&
        role !== 'user' &&
        role !== 'tool' &&
        role !== 'system'
      ) {
        return null;
      }
      // Pi's content may be a string OR a structured array of blocks
      // (mirroring Anthropic-style content shapes). Flatten to a
      // string for our `message` event — first-pass simplification
      // matches what L2 needs for ticket-chat persistence.
      const content = extractMessageContent(message.content);
      if (content === null) return null;
      return {
        kind: 'message',
        role,
        content,
        timestamp: now,
      };
    }

    case 'agent_end': {
      // Terminal: pi finished its agent loop. Extract a summary
      // from the final assistant message (if available); pi doesn't
      // surface cost in the stream — report 0 informational.
      const messages = Array.isArray(raw.messages) ? raw.messages : [];
      const summary = extractFinalAssistantText(messages);
      return {
        kind: 'result',
        exitCode: 0,
        summary,
        costUsd: 0,
        terminalReason: 'completed',
        timestamp: now,
      };
    }

    default:
      // agent_start / turn_start / message_start / message_update /
      // tool_execution_update / queue_update / compaction_* /
      // auto_retry_* — bookkeeping events with no harness equivalent
      // in v1. Drop silently.
      return null;
  }
}

/** Flatten pi's `message.content` into a string. Handles three
 *  shapes:
 *    - string (most common)
 *    - array of blocks `[{type: 'text', text: '...'}]`
 *    - anything else → null (drop the event) */
export function extractMessageContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') parts.push(b.text);
      } else if (typeof block === 'string') {
        parts.push(block);
      }
    }
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

/** Walk pi's `agent_end.messages` and extract the LAST assistant
 *  message's text content. Empty string when no assistant message
 *  was found (rare). */
export function extractFinalAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    const msg = m as Record<string, unknown>;
    if (msg.role !== 'assistant') continue;
    const text = extractMessageContent(msg.content);
    if (text !== null && text.length > 0) return text;
  }
  return '';
}

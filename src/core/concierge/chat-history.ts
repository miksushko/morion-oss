/**
 * Direction V — chat-history reconstruction for re-feeding past
 * conversation turns to the LLM provider.
 *
 * Why this file exists (umbrella ticket 01KQ1R97C0GK6KPQF03AFCZ42B,
 * round 2 — 2026-04-25):
 *
 * The DB persists assistant tool-calling turns as TEXT markers, not
 * structured `tool_calls` JSON columns:
 *   - non-destructive turns get a `(querying workspace:\n- toolName(args))`
 *     marker on the assistant row; the result lives in subsequent
 *     `role='tool'` rows linked by `tool_call_id`.
 *   - destructive turns get a `__MO_PENDING_TOOL_APPROVAL__\n{json}`
 *     sentinel; the JSON payload carries the structured tool calls.
 *
 * When the chat loop re-feeds prior history to the provider on a
 * subsequent user message, the simple `messages.map(m => ({role,
 * content, toolCallId}))` we used to do produced an OpenAI-malformed
 * sequence: `role='tool'` messages whose preceding assistant turn had
 * no `tool_calls` field. Strict providers reject; permissive ones get
 * confused. Symptom: Mo "uses tags_list, then disappears with no
 * follow-up message" after a previous tool-calling round.
 *
 * Fix is local to the re-feed step. We parse the markers back into
 * structured `LLMMessage[]` whose assistant rows carry the original
 * `toolCalls`. The DB schema stays unchanged — markers continue to
 * be the wire format on disk; structure only matters when we hand
 * the conversation back to the provider.
 *
 * Args fidelity caveat: `(querying workspace:\n- name(args))` slices
 * `args` at 80 chars (`truncatePreview`). Reconstructed argumentsJson
 * is therefore best-effort — if it doesn't parse as valid JSON we
 * substitute `{}`. The provider treats prior-turn `tool_calls` as
 * informational; the model sees the actual results in the paired
 * `role='tool'` rows, which are fully persisted. Tests pin this.
 */

import type { ConciergeMessage } from './types.js';
import type { LLMMessage, LLMToolCall } from './provider.js';
import { isPendingToolMessage, parsePendingToolMessage } from './chat-approvals.js';

/**
 * Marker the chat loop writes on assistant rows that emitted
 * non-destructive tool calls. Mirrors the UI's `QUERY_MARKER` constant
 * (kept duplicated per the CLAUDE.md core/web boundary).
 */
export const CHAT_QUERY_MARKER = '(querying workspace:';

interface ParsedQueryLine {
  name: string;
  args: string;
}

function extractPreface(content: string): string {
  const idx = content.indexOf(CHAT_QUERY_MARKER);
  if (idx <= 0) return '';
  return content.slice(0, idx).trim();
}

function extractQueryLines(content: string): ParsedQueryLine[] {
  const idx = content.indexOf(CHAT_QUERY_MARKER);
  if (idx < 0) return [];
  const tail = content.slice(idx);
  const lines = tail.split('\n').filter((l) => l.trim().startsWith('- '));
  return lines.map((l) => {
    const body = l.trim().replace(/^-\s*/, '');
    const m = body.match(/^([\w_.-]+)\((.*)\)$/);
    if (!m) return { name: body, args: '' };
    // Trailing ellipsis means truncatePreview cut the args; we strip
    // the marker and try to parse below — falling back to '{}' if the
    // residue isn't valid JSON.
    return { name: m[1]!, args: m[2]!.replace(/…$/, '') };
  });
}

function safeArgsJson(raw: string): string {
  if (!raw) return '{}';
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return '{}';
  }
}

/**
 * Walk the persisted transcript and rebuild an `LLMMessage[]` whose
 * assistant tool-calling turns carry structured `toolCalls` arrays
 * pointing at the same `tool_call_id`s as the following `role='tool'`
 * rows.
 *
 * Filters:
 *   - drops `role='system'` rows (the caller prepends a fresh system
 *     prompt each turn so tone toggles take effect immediately).
 *   - keeps the pending sentinel rows by reconstructing them from
 *     their JSON payload — this matters when the user's next message
 *     arrives WHILE a pending row is in the transcript (rare; usually
 *     /tool-approve resolves first, but the path must be safe).
 *
 * Resolved-vs-unresolved pending detection (Codex finding #1 in ticket
 * `01KQ2A5HTVG4WYFJE6RNP9D57G`): a pending sentinel is "resolved" once
 * `/tool-approve` has dispatched its calls and persisted matching
 * `role='tool'` rows. If the user typed a normal /messages turn BEFORE
 * resolving (e.g. abandoned the approval card), the sentinel exists
 * but no tool result rows do. Replaying it as an `assistant(tool_calls)`
 * with no matching tool messages produces a malformed sequence the
 * provider rejects. Fix: treat unresolved sentinels as plain assistant
 * text turns (preface only), drop the structured `toolCalls`.
 */
function buildToolCallIdSet(messages: ConciergeMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) ids.add(m.toolCallId);
  }
  return ids;
}

export function reconstructLLMHistory(
  messages: ConciergeMessage[],
): LLMMessage[] {
  const out: LLMMessage[] = [];
  // Pre-scan all tool result rows once so we can ask "did this pending
  // sentinel's calls actually get dispatched?" in O(1) per pending.
  const allToolCallIds = buildToolCallIdSet(messages);
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;

    if (m.role === 'system') {
      i += 1;
      continue;
    }

    // Pending sentinel — JSON payload has the structured calls.
    if (m.role === 'assistant' && isPendingToolMessage(m.content)) {
      const payload = parsePendingToolMessage(m.content);
      if (payload) {
        // Resolved iff every call id has a matching tool result row.
        // /tool-approve dispatches all calls (destructive + non-
        // destructive) atomically, so partial resolution shouldn't
        // happen in practice — but we check `every` defensively.
        const resolved =
          payload.toolCalls.length === 0 ||
          payload.toolCalls.every((c) => allToolCallIds.has(c.id));
        if (resolved) {
          out.push({
            role: 'assistant',
            content: payload.preface,
            toolCalls: payload.toolCalls.map(
              (c): LLMToolCall => ({
                id: c.id,
                name: c.name,
                argumentsJson: c.argumentsJson,
              }),
            ),
          });
        } else {
          // Unresolved — emit as plain assistant text. The structured
          // tool_calls would orphan in the provider's view (no matching
          // role='tool' rows downstream). Falling back to text keeps
          // the conversation valid; the original approval card remains
          // visible in the UI for the user to resolve when they want.
          out.push({
            role: 'assistant',
            content: payload.preface,
          });
        }
        i += 1;
        continue;
      }
      // Malformed pending — fall through to raw passthrough; the
      // provider sees it as a plain assistant text turn. Still
      // structurally valid.
    }

    // Query-marker assistant turn — reconstruct toolCalls by pairing
    // the marker's tool names with the tool_call_ids on the
    // immediately-following role='tool' rows.
    if (m.role === 'assistant' && m.content.includes(CHAT_QUERY_MARKER)) {
      const preface = extractPreface(m.content);
      const queryLines = extractQueryLines(m.content);
      // Look ahead for the matching tool result rows (same count as
      // queryLines, contiguous, all role='tool' with toolCallId).
      const pairedIds: Array<string | null> = [];
      let j = i + 1;
      while (
        pairedIds.length < queryLines.length &&
        j < messages.length &&
        messages[j]!.role === 'tool'
      ) {
        pairedIds.push(messages[j]!.toolCallId);
        j += 1;
      }
      // Pad with synthesised IDs if some tool rows are missing (should
      // not happen with the current engine — but defensive: a
      // structurally-valid synth id keeps the provider's
      // tool_call_id pairing consistent).
      const toolCalls: LLMToolCall[] = queryLines.map((q, idx) => ({
        id: pairedIds[idx] ?? `synth_${m.id}_${idx}`,
        name: q.name,
        argumentsJson: safeArgsJson(q.args),
      }));
      out.push({
        role: 'assistant',
        content: preface,
        toolCalls,
      });
      i += 1;
      continue;
    }

    // Plain assistant / user / tool — passthrough with the right
    // shape. Tool messages keep their toolCallId so they pair with
    // the assistant turn we just reconstructed above.
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: m.content,
        toolCallId: m.toolCallId,
      });
    } else {
      out.push({
        role: m.role,
        content: m.content,
        toolCallId: m.toolCallId,
      });
    }
    i += 1;
  }
  return dropOrphanToolMessages(out);
}

/**
 * Defensive final pass — drop orphans on BOTH sides of the assistant /
 * tool pairing:
 *
 *   (a) `role='tool'` messages whose parent assistant turn isn't
 *       visible in the window (cut head of a long session, or
 *       collapsed-to-text unresolved pending).
 *   (b) `tool_calls` entries on an assistant turn that have NO matching
 *       `role='tool'` row before the next non-tool message. These
 *       orphan when a previous chat turn's tool dispatch crashed
 *       between persisting the assistant marker and the tool result —
 *       the next chat turn would then re-feed an assistant with
 *       tool_calls but no matching tool messages, which strict
 *       providers (OpenAI / Anthropic) reject and route returns 500.
 *
 * Pairing rule: an assistant tool_call is valid iff a `role='tool'`
 * row with the same `tool_call_id` lands BEFORE the next non-tool
 * message. Otherwise drop just that call (or collapse the whole
 * `toolCalls` field if every call orphans).
 *
 * Symmetrically: a tool message is valid iff its `tool_call_id` is on
 * the most-recent assistant's tool_calls AND that call hasn't already
 * been paired (no double-pairing).
 *
 * 2026-04-26 — symmetric orphan trimming added after a chat session
 * 500'd because of an assistant marker stranded by a crashed tool
 * dispatch on the previous turn. Ticket `01KQ2ZZ969G4RCC20C67M5SJV2`.
 */
function dropOrphanToolMessages(messages: LLMMessage[]): LLMMessage[] {
  // Pass 1: build per-assistant index of which tool_call_ids actually
  // have a matching role='tool' downstream BEFORE the next non-tool
  // message.
  const matchedAssistantCalls = new Map<number, Set<string>>(); // assistant idx → matched ids
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || !m.toolCalls || m.toolCalls.length === 0) continue;
    const declared = new Set(m.toolCalls.map((c) => c.id));
    const matched = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === 'tool') {
      const tid = messages[j]!.toolCallId;
      if (tid && declared.has(tid) && !matched.has(tid)) {
        matched.add(tid);
      }
      j++;
    }
    matchedAssistantCalls.set(i, matched);
  }

  // Pass 2: emit. Trim assistant tool_calls down to matched ids; drop
  // orphan tool messages whose toolCallId never landed on the
  // most-recent assistant.
  const out: LLMMessage[] = [];
  let activeIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const matched = matchedAssistantCalls.get(i) ?? new Set<string>();
        const trimmed = m.toolCalls.filter((c) => matched.has(c.id));
        if (trimmed.length === m.toolCalls.length) {
          activeIds = new Set(matched);
          out.push(m);
        } else if (trimmed.length === 0) {
          // Every call orphaned — collapse to plain assistant text turn.
          // Drop the toolCalls field entirely so the provider sees a
          // valid sequence.
          activeIds = new Set();
          out.push({ role: 'assistant', content: m.content });
        } else {
          // Partial: some calls had matching results, some didn't.
          // Keep the matched ones; the unmatched calls are dropped
          // along with… they have no tool rows to drop, by definition.
          activeIds = new Set(matched);
          out.push({ role: 'assistant', content: m.content, toolCalls: trimmed });
        }
      } else {
        activeIds = new Set();
        out.push(m);
      }
      continue;
    }
    if (m.role === 'tool') {
      if (m.toolCallId && activeIds.has(m.toolCallId)) {
        out.push(m);
        activeIds.delete(m.toolCallId);
      }
      // else: orphan tool — drop.
      continue;
    }
    // Any other role (user, system) closes the active tool-call window.
    activeIds = new Set();
    out.push(m);
  }
  return out;
}

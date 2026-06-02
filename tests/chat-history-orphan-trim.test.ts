/**
 * Regression: chat session 500'd because a previous turn's tool dispatch
 * crashed between persisting the assistant marker and the tool result row.
 * The next /messages call rebuilt the transcript, fed an assistant turn
 * with `tool_calls` whose ids had no matching `role='tool'` rows, and the
 * provider returned 400 → route returned 500.
 *
 * Fix: `dropOrphanToolMessages` now trims orphan tool_calls off assistant
 * turns SYMMETRICALLY with the existing orphan-tool-message drop. If an
 * assistant declares N calls but only K downstream tool rows match
 * before the next non-tool message, the unmatched calls are dropped (or
 * the whole `toolCalls` field is dropped if K=0). Provider sees a
 * structurally-valid sequence regardless of past dispatch crashes.
 *
 * Ticket `01KQ2ZZ969G4RCC20C67M5SJV2`.
 */
import { describe, it, expect } from 'vitest';
import { reconstructLLMHistory } from '../src/core/concierge/chat-history.js';
import type { ConciergeMessage } from '../src/core/concierge/types.js';

function msg(partial: Partial<ConciergeMessage> & Pick<ConciergeMessage, 'id' | 'role' | 'content'>): ConciergeMessage {
  return {
    sessionId: 'sess1',
    toolCallId: null,
    costUsd: 0,
    tokensIn: null,
    tokensOut: null,
    model: null,
    createdAt: 0,
    ...partial,
  } as ConciergeMessage;
}

describe('reconstructLLMHistory — orphan trim (assistant side)', () => {
  it('an assistant marker with NO tool result downstream → toolCalls dropped, turn becomes plain text', () => {
    // The exact shape that caused the user's 500: row 6 was an
    // assistant marker for `mo_remember(...)` whose dispatch crashed
    // — no row 7 (tool result) ever landed. Then row 8 was a user
    // message. On the next chat turn, history reconstruction must
    // NOT feed the provider an orphan assistant-with-tool_calls.
    const transcript: ConciergeMessage[] = [
      msg({ id: '1', role: 'user', content: 'remember я месье' }),
      msg({
        id: '2',
        role: 'assistant',
        content: '(querying workspace:\n- mo_remember({"fact":"месье"}))',
      }),
      // NO tool result for id '2' — dispatch crashed.
      msg({ id: '3', role: 'user', content: 'месье конечно' }),
    ];
    const out = reconstructLLMHistory(transcript);
    // Find the assistant turn — its toolCalls must be undefined or empty
    const assistant = out.find((m) => m.role === 'assistant');
    expect(assistant).toBeTruthy();
    expect(assistant!.toolCalls === undefined || assistant!.toolCalls.length === 0).toBe(true);
    // Sequence must NOT have any role='tool' rows (none existed)
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(0);
  });

  it('partial-orphan: assistant declares 2 calls, only 1 has a matching result → unmatched call dropped', () => {
    const transcript: ConciergeMessage[] = [
      msg({ id: '1', role: 'user', content: 'multi' }),
      msg({
        id: '2',
        role: 'assistant',
        content: '(querying workspace:\n- foo({})\n- bar({}))',
      }),
      // Only one tool row — paired with the FIRST call (synth id matching first paired position)
      msg({ id: '3', role: 'tool', content: 'foo result', toolCallId: '3' }),
      msg({ id: '4', role: 'user', content: 'next' }),
    ];
    const out = reconstructLLMHistory(transcript);
    const assistant = out.find((m) => m.role === 'assistant');
    expect(assistant).toBeTruthy();
    // Only ONE call survives (the one with a matching tool row)
    expect(assistant!.toolCalls?.length).toBe(1);
    // The kept tool message pairs to the surviving call
    const toolMsgs = out.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0]!.toolCallId).toBe(assistant!.toolCalls![0]!.id);
  });

  it('all-paired assistant turn passes through unchanged', () => {
    const transcript: ConciergeMessage[] = [
      msg({ id: '1', role: 'user', content: 'q' }),
      msg({
        id: '2',
        role: 'assistant',
        content: '(querying workspace:\n- foo({}))',
      }),
      msg({ id: '3', role: 'tool', content: 'result', toolCallId: '3' }),
      msg({ id: '4', role: 'assistant', content: 'done' }),
    ];
    const out = reconstructLLMHistory(transcript);
    const firstAssistant = out.find((m) => m.role === 'assistant');
    expect(firstAssistant!.toolCalls?.length).toBe(1);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('orphan tool message (no preceding assistant tool_call) still dropped — original contract preserved', () => {
    const transcript: ConciergeMessage[] = [
      msg({ id: '1', role: 'user', content: 'q' }),
      msg({ id: '2', role: 'tool', content: 'orphan', toolCallId: 'unknown' }),
      msg({ id: '3', role: 'assistant', content: 'reply' }),
    ];
    const out = reconstructLLMHistory(transcript);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(0);
  });

  it('two assistant tool-call turns in a row: first orphans, second pairs cleanly', () => {
    const transcript: ConciergeMessage[] = [
      msg({ id: '1', role: 'user', content: 'q1' }),
      // First assistant turn — orphaned (no tool result followed)
      msg({ id: '2', role: 'assistant', content: '(querying workspace:\n- foo({}))' }),
      // User started a new turn before the first finished
      msg({ id: '3', role: 'user', content: 'q2' }),
      // Second assistant turn — paired
      msg({ id: '4', role: 'assistant', content: '(querying workspace:\n- bar({}))' }),
      msg({ id: '5', role: 'tool', content: 'bar result', toolCallId: '5' }),
    ];
    const out = reconstructLLMHistory(transcript);
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    // First: orphan trimmed → no toolCalls
    expect(assistants[0]!.toolCalls === undefined || assistants[0]!.toolCalls.length === 0).toBe(true);
    // Second: paired → 1 toolCall
    expect(assistants[1]!.toolCalls?.length).toBe(1);
    // Exactly one tool row preserved
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(1);
  });
});

/**
 * Regression: three edge cases on Mo's chat tool-call history that
 * Codex flagged after the round-2 fix `01KQ24GDQTCPC9H9BBC7JT4C6C`.
 *
 * Ticket: `01KQ2A5HTVG4WYFJE6RNP9D57G` — Bug: Mo chat tool-call history
 * can become invalid across pending approvals and long sessions.
 *
 * Each test pins one finding's contract:
 *
 *  1. Unresolved pending sentinels collapse to plain assistant text
 *     when reconstructed (no orphan `tool_calls`).
 *  2. `/tool-approve` rebuilds prior resolved approval cycles into
 *     valid assistant/tool_calls + tool message pairs (no orphan tool
 *     rows from earlier pendings being filtered out).
 *  3. `listLatestBySession` returns the latest-N rows oldest-first so
 *     the newest user message survives the window cap.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import {
  ConciergeMessagesRepository,
  ConciergeSessionsRepository,
  formatPendingToolMessage,
  reconstructLLMHistory,
  type ConciergeMessage,
} from '../src/core/concierge/index.js';

interface Ctx {
  handle: DbHandle;
  sessions: ConciergeSessionsRepository;
  messages: ConciergeMessagesRepository;
  sessionId: string;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const sessions = new ConciergeSessionsRepository(handle.db);
  const messages = new ConciergeMessagesRepository(handle.db);
  const session = sessions.create({ openedBy: 'user' });
  return { handle, sessions, messages, sessionId: session.id };
}

describe('Codex finding #1 — unresolved pending sentinel collapses to plain text', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('emits no tool_calls when the pending has no matching tool result rows', () => {
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'user',
      content: 'delete that note',
    });
    // Mo emitted a destructive tool call → pending sentinel persisted.
    // User then typed a NEW user message instead of resolving — so no
    // role='tool' rows exist downstream of this sentinel.
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'assistant',
      content: formatPendingToolMessage({
        preface: "I'll handle that.",
        toolCalls: [
          { id: 'call_x', name: 'notes_delete', argumentsJson: '{"id":"01KQ_NOTE"}' },
        ],
        destructiveCallIds: ['call_x'],
        model: null,
      }),
    });
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'user',
      content: 'actually never mind, list my tags',
    });

    const transcript = ctx.messages.listBySession(ctx.sessionId);
    const reconstructed = reconstructLLMHistory(transcript);

    // Find the assistant turn from the pending sentinel.
    const assistantTurn = reconstructed.find(
      (m) => m.role === 'assistant' && m.content === "I'll handle that.",
    );
    expect(assistantTurn).toBeDefined();
    // Crucially: NO tool_calls field. Provider would otherwise see
    // assistant(tool_calls) → user with no role='tool' between.
    expect(assistantTurn!.toolCalls).toBeUndefined();
  });

  it('keeps tool_calls when the pending IS resolved (downstream tool rows exist)', () => {
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'user',
      content: 'delete it',
    });
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'assistant',
      content: formatPendingToolMessage({
        preface: 'doing it',
        toolCalls: [
          { id: 'call_resolved', name: 'notes_delete', argumentsJson: '{}' },
        ],
        destructiveCallIds: ['call_resolved'],
        model: null,
      }),
    });
    // /tool-approve dispatch persisted the matching tool row.
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'tool',
      content: '{"ok":true}',
      toolCallId: 'call_resolved',
    });

    const transcript = ctx.messages.listBySession(ctx.sessionId);
    const reconstructed = reconstructLLMHistory(transcript);

    const assistantTurn = reconstructed.find(
      (m) => m.role === 'assistant' && m.content === 'doing it',
    );
    expect(assistantTurn?.toolCalls).toBeDefined();
    expect(assistantTurn!.toolCalls).toHaveLength(1);
    expect(assistantTurn!.toolCalls![0]!.id).toBe('call_resolved');
  });
});

describe('Codex finding #2 — earlier resolved approvals stay paired in reconstruction', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('two destructive cycles keep both tool result rows paired with their structured assistant turns', () => {
    // Cycle 1
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'user',
      content: 'delete tag A',
    });
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'assistant',
      content: formatPendingToolMessage({
        preface: 'cycle 1 prefix',
        toolCalls: [
          { id: 'call_c1', name: 'tags_delete', argumentsJson: '{"id":"A"}' },
        ],
        destructiveCallIds: ['call_c1'],
        model: null,
      }),
    });
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'tool',
      content: '{"ok":true}',
      toolCallId: 'call_c1',
    });
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'assistant',
      content: 'cycle 1 done.',
    });

    // Cycle 2
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'user',
      content: 'now delete tag B',
    });
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'assistant',
      content: formatPendingToolMessage({
        preface: 'cycle 2 prefix',
        toolCalls: [
          { id: 'call_c2', name: 'tags_delete', argumentsJson: '{"id":"B"}' },
        ],
        destructiveCallIds: ['call_c2'],
        model: null,
      }),
    });
    ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'tool',
      content: '{"ok":true}',
      toolCallId: 'call_c2',
    });

    const transcript = ctx.messages.listBySession(ctx.sessionId);
    const reconstructed = reconstructLLMHistory(transcript);

    // Both tool rows must remain in the reconstruction AND be preceded
    // by their matching assistant tool_calls turn.
    const c1ToolIdx = reconstructed.findIndex(
      (m) => m.role === 'tool' && m.toolCallId === 'call_c1',
    );
    const c2ToolIdx = reconstructed.findIndex(
      (m) => m.role === 'tool' && m.toolCallId === 'call_c2',
    );
    expect(c1ToolIdx).toBeGreaterThan(0);
    expect(c2ToolIdx).toBeGreaterThan(c1ToolIdx);

    const c1Parent = reconstructed
      .slice(0, c1ToolIdx)
      .reverse()
      .find((m) => m.role === 'assistant');
    expect(c1Parent?.toolCalls?.find((c) => c.id === 'call_c1')).toBeDefined();

    const c2Parent = reconstructed
      .slice(0, c2ToolIdx)
      .reverse()
      .find((m) => m.role === 'assistant');
    expect(c2Parent?.toolCalls?.find((c) => c.id === 'call_c2')).toBeDefined();
  });
});

describe('Codex finding #3 — listLatestBySession includes the newest user message in long sessions', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns the LAST N rows oldest-first when row count exceeds the cap', () => {
    // Stuff the session with 600 messages — older than the chat cap.
    for (let i = 0; i < 600; i++) {
      ctx.messages.create({
        sessionId: ctx.sessionId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `filler-${i}`,
      });
    }
    // The actual user message we expect to survive the window cap.
    const newestUser = ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'user',
      content: 'this is the user question that MUST reach Mo',
    });

    const window = ctx.messages.listLatestBySession(ctx.sessionId, 500);
    expect(window).toHaveLength(500);
    // Oldest-first ordering preserved.
    for (let i = 1; i < window.length; i++) {
      expect(window[i]!.createdAt).toBeGreaterThanOrEqual(window[i - 1]!.createdAt);
    }
    // Newest user is the very last row of the window.
    const last = window[window.length - 1]!;
    expect(last.id).toBe(newestUser.id);
    expect(last.content).toBe('this is the user question that MUST reach Mo');
  });

  it('listBySession (legacy oldest-first) misses the newest user — pins the contrast', () => {
    for (let i = 0; i < 600; i++) {
      ctx.messages.create({
        sessionId: ctx.sessionId,
        role: 'user',
        content: `f-${i}`,
      });
    }
    const newest = ctx.messages.create({
      sessionId: ctx.sessionId,
      role: 'user',
      content: 'newest',
    });
    const oldestFirst = ctx.messages.listBySession(ctx.sessionId, 500);
    // Confirms the bug: newest message is OUT of the window when using
    // the legacy method. Test exists so a future "let's just bump
    // listBySession to DESC" change doesn't silently break paginated
    // UI consumers that depend on the old semantics.
    expect(oldestFirst.find((m) => m.id === newest.id)).toBeUndefined();
  });
});

describe('Codex finding #3 follow-up — leading orphan tool rows get dropped', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('drops role=tool messages whose parent assistant.tool_calls is outside the window', () => {
    // Simulate a window cut: history starts mid tool-call sequence.
    // Construct the messages directly via createSerial (bypasses the
    // session insert path so we can shape the transcript precisely).
    const orphanTool: ConciergeMessage = {
      id: 'orphan-tool',
      sessionId: ctx.sessionId,
      role: 'tool',
      content: '{"ok":true}',
      toolCallId: 'call_lost', // no preceding assistant in the window
      costUsd: 0,
      tokensIn: null,
      tokensOut: null,
      model: null,
      createdAt: 1,
    };
    const followupUser: ConciergeMessage = {
      id: 'user-1',
      sessionId: ctx.sessionId,
      role: 'user',
      content: 'hi mo',
      toolCallId: null,
      costUsd: 0,
      tokensIn: null,
      tokensOut: null,
      model: null,
      createdAt: 2,
    };
    const reconstructed = reconstructLLMHistory([orphanTool, followupUser]);
    // Orphan tool row dropped; user message survives.
    expect(reconstructed.find((m) => m.role === 'tool')).toBeUndefined();
    expect(reconstructed.map((m) => m.role)).toEqual(['user']);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { activatePro, json, setup, type Ctx } from './helpers/concierge-http-setup.js';

/**
 * HTTP /api/concierge/sessions/:id/tool-approve
 *
 * Extracted 2026-05-16 from tests/concierge-http.test.ts as part of the
 * oversized-file split (Morion ticket 01KRJZ050EX392K9NY7GAKA1JE).
 */

describe('HTTP /api/concierge/sessions/:id/tool-approve (Codex 01KQ1H5MKPBG7DY0730VRRW178)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx.settings);
  });

  /** Stash a pending-tool sentinel directly so we can test
   * /tool-approve in isolation without driving a real LLM provider.
   * The /messages → pending flow's loop logic is unit-covered by
   * tests/chat-approvals.test.ts. */
  function persistPendingTool(
    sessionId: string,
    payload: {
      toolCalls: Array<{ id: string; name: string; argumentsJson: string }>;
      destructiveCallIds: string[];
      preface?: string;
    },
  ): { messageId: string } {
    const marker = '__MO_PENDING_TOOL_APPROVAL__';
    const row = ctx.concierge.messages.create({
      sessionId,
      role: 'assistant',
      content: `${marker}\n${JSON.stringify({
        preface: payload.preface ?? '',
        toolCalls: payload.toolCalls,
        destructiveCallIds: payload.destructiveCallIds,
        model: null,
      })}`,
      model: null,
    });
    return { messageId: row.id };
  }

  it('approve dispatches a notes_delete and persists tool result', async () => {
    const s = ctx.concierge.sessions.create({ openedBy: 'user' });
    const note = ctx.notes.create(
      { body: 'Doomed', source: 'user' },
      'user',
    );
    const { messageId } = persistPendingTool(s.id, {
      preface: "I'll clean this up.",
      toolCalls: [
        { id: 'call_a', name: 'notes_delete', argumentsJson: JSON.stringify({ id: note.id }) },
      ],
      destructiveCallIds: ['call_a'],
    });
    const res = await ctx.app.request(
      `/api/concierge/sessions/${s.id}/tool-approve`,
      json({ messageId, decision: 'approve' }),
    );
    expect(res.status).toBe(200);
    // Note should be soft-deleted (deleted_at set).
    const fetched = ctx.notes.getById(note.id, { includeTrashed: true });
    expect(fetched?.deletedAt).not.toBeNull();
    // Tool result row exists with toolCallId='call_a'.
    const transcript = ctx.concierge.messages.listBySession(s.id);
    const toolRow = transcript.find((m) => m.toolCallId === 'call_a');
    expect(toolRow).toBeDefined();
    expect(toolRow!.role).toBe('tool');
  });

  it('deny does NOT delete + writes a user_denied envelope as the tool result', async () => {
    const s = ctx.concierge.sessions.create({ openedBy: 'user' });
    const note = ctx.notes.create(
      { body: 'Stays alive', source: 'user' },
      'user',
    );
    const { messageId } = persistPendingTool(s.id, {
      toolCalls: [
        { id: 'call_b', name: 'notes_delete', argumentsJson: JSON.stringify({ id: note.id }) },
      ],
      destructiveCallIds: ['call_b'],
    });
    const res = await ctx.app.request(
      `/api/concierge/sessions/${s.id}/tool-approve`,
      json({ messageId, decision: 'deny', reason: 'Wrong target.' }),
    );
    expect(res.status).toBe(200);
    // Note still alive.
    const fetched = ctx.notes.getById(note.id);
    expect(fetched?.deletedAt).toBeNull();
    // Tool result row carries user_denied + reason snippet.
    const transcript = ctx.concierge.messages.listBySession(s.id);
    const toolRow = transcript.find((m) => m.toolCallId === 'call_b');
    expect(toolRow!.role).toBe('tool');
    expect(toolRow!.content).toContain('user_denied');
    expect(toolRow!.content).toContain('Wrong target');
  });

  it('returns 409 on second approve (idempotency)', async () => {
    const s = ctx.concierge.sessions.create({ openedBy: 'user' });
    const note = ctx.notes.create(
      { body: 'Once', source: 'user' },
      'user',
    );
    const { messageId } = persistPendingTool(s.id, {
      toolCalls: [
        { id: 'call_c', name: 'notes_delete', argumentsJson: JSON.stringify({ id: note.id }) },
      ],
      destructiveCallIds: ['call_c'],
    });
    const first = await ctx.app.request(
      `/api/concierge/sessions/${s.id}/tool-approve`,
      json({ messageId, decision: 'approve' }),
    );
    expect(first.status).toBe(200);
    const second = await ctx.app.request(
      `/api/concierge/sessions/${s.id}/tool-approve`,
      json({ messageId, decision: 'approve' }),
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe('already_resolved');
  });

  it('returns 404 when the messageId does not point at a pending row', async () => {
    const s = ctx.concierge.sessions.create({ openedBy: 'user' });
    const res = await ctx.app.request(
      `/api/concierge/sessions/${s.id}/tool-approve`,
      json({ messageId: '01KQ_NOT_THERE', decision: 'approve' }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when the message exists but is not a pending sentinel', async () => {
    const s = ctx.concierge.sessions.create({ openedBy: 'user' });
    const plainAssistant = ctx.concierge.messages.create({
      sessionId: s.id,
      role: 'assistant',
      content: 'just a regular reply',
    });
    const res = await ctx.app.request(
      `/api/concierge/sessions/${s.id}/tool-approve`,
      json({ messageId: plainAssistant.id, decision: 'approve' }),
    );
    expect(res.status).toBe(400);
  });

  // Free-tier gate is uniform across concierge mutation routes —
  // covered by the /messages 402 test above. No separate regression
  // needed here.
});

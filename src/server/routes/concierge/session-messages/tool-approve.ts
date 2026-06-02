/**
 * POST /api/concierge/sessions/:id/tool-approve
 *
 * Codex finding 01KQ1H5MKPBG7DY0730VRRW178. When Mo's chat loop emits
 * a `category === 'delete'` tool, the server pauses and persists a
 * sentinel row instead of dispatching. The user clicks Approve / Deny
 * in the UI, which hits this endpoint; we then dispatch (or synthesise
 * a deny envelope), persist the tool result rows, and re-enter the
 * chat loop so Mo can react.
 *
 * Idempotency: a tool-role row AFTER the pending whose `toolCallId`
 * matches one of THIS pending's destructive calls means the approval
 * was already resolved — return 409 instead of double-dispatching.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  buildChatSystemPrompt,
  deniedToolResult,
  dispatchMoTool,
  MO_ACTOR,
  parsePendingToolMessage,
  reconstructLLMHistory,
  serializeMoToolResultForChat,
  type ConciergeMessage,
  type LLMMessage,
} from '../../../../core/concierge/index.js';
import {
  readChatModelFallback,
  readProviderModel,
} from '../../../features/concierge-deps/index.js';
import { ALL_TOOLS } from '../../../tools/index.js';
import type { ToolContext } from '../../../tools/types.js';
import { runMoChatLoop } from '../mo-chat-loop.js';
import { asHost, requireConciergeDeps, resolveProjectCatalog } from '../shared.js';

const toolApprovalSchema = z.object({
  messageId: z.string().min(1).max(64),
  decision: z.enum(['approve', 'deny']),
  reason: z.string().max(500).optional(),
});

export function registerToolApproveRoute(app: Hono, ctx: ToolContext): void {
  app.post('/api/concierge/sessions/:id/tool-approve', (c) =>
    handleToolApprove(c, ctx, c.req.param('id')),
  );
}

async function handleToolApprove(c: Context, ctx: ToolContext, sessionId: string) {
  const bag = requireConciergeDeps(ctx);
  if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
  const session = bag.bag.sessions.get(sessionId);
  if (!session) return c.json({ error: 'not_found' }, 404);
  const body = toolApprovalSchema.parse(await c.req.json());

  // `listLatestBySession` here so a deep session can't push the
  // pending row out of the window while keeping pre-pending context
  // visible. Same Codex finding #3 reasoning as /messages.
  const allMessages = bag.bag.messages.listLatestBySession(sessionId, 1000);
  const pendingIdx = allMessages.findIndex((m) => m.id === body.messageId);
  if (pendingIdx === -1) {
    return c.json({ error: 'pending_message_not_found' }, 404);
  }
  const pendingMsg = allMessages[pendingIdx]!;
  const pending = parsePendingToolMessage(pendingMsg.content);
  if (!pending) {
    return c.json({ error: 'not_a_pending_tool_message' }, 400);
  }

  // Idempotency — a tool-role row AFTER the pending whose
  // `toolCallId` matches one of THIS pending's destructive calls
  // means the approval was already resolved. Reject the second
  // click so we don't double-dispatch destructive operations.
  //
  // Tightened from "any tool row downstream" (2026-04-25 first cut)
  // to "tool row matching this pending's call ids" so a chat path
  // that had OTHER pending+resolution cycles between this one and
  // now still lets us re-check this specific row's state (though
  // in practice the UI hides the buttons after resolution, so the
  // 409 is only ever a safety net for double-clicks / stale tabs).
  const destructiveIdSet = new Set(pending.destructiveCallIds);
  const after = allMessages.slice(pendingIdx + 1);
  const alreadyResolved = after.some(
    (m) =>
      m.role === 'tool' &&
      m.toolCallId !== null &&
      destructiveIdSet.has(m.toolCallId),
  );
  if (alreadyResolved) {
    return c.json({ error: 'already_resolved' }, 409);
  }

  // Pre-check budget — same gate as /messages so a denied turn
  // doesn't burn Pro budget on a continuation provider call.
  const budgetStatus = bag.bag.budget.status();
  if (!budgetStatus.withinBudget) {
    const assistantMsg = bag.bag.messages.create({
      sessionId,
      role: 'assistant',
      content:
        'Concierge paused — daily budget exhausted. Resets at UTC midnight.',
    });
    return c.json({ assistant: assistantMsg, budget: budgetStatus });
  }

  const { provider, model } = readProviderModel(asHost(ctx));
  const fallbackModel = readChatModelFallback(asHost(ctx));

  // Dispatch every tool call from the pending payload. Destructive
  // ones honour the user's decision; non-destructive ones always
  // dispatch (they're queued behind the destructive sibling but the
  // user only approves the destructive — non-destructive tools were
  // never the gating concern).
  const moCtx = { ...ctx, actor: MO_ACTOR };
  const destructiveSet = new Set(pending.destructiveCallIds);
  const toolResultRows: ConciergeMessage[] = [];
  const runningMessagesPostDispatch: LLMMessage[] = [];
  runningMessagesPostDispatch.push({
    role: 'assistant',
    content: pending.preface,
    toolCalls: pending.toolCalls,
  });
  for (const call of pending.toolCalls) {
    const isDestructive = destructiveSet.has(call.id);
    const result =
      isDestructive && body.decision === 'deny'
        ? deniedToolResult(body.reason ?? null)
        : await dispatchMoTool(
            ALL_TOOLS,
            { name: call.name, argumentsJson: call.argumentsJson },
            moCtx,
          );
    // serializeMoToolResultForChat enforces a hard byte budget WITHOUT
    // slicing JSON mid-string — the previous `.slice(0, 12_000)` cut
    // arrays mid-object and made Mo report phantom undercounts (e.g.
    // "1 task" on a 51-card board, 2026-04-25). See mo-tools.ts.
    const { json: payload } = serializeMoToolResultForChat(call.name, result);
    const row = bag.bag.messages.create({
      sessionId,
      role: 'tool',
      content: payload,
      toolCallId: call.id,
      model: pending.model,
    });
    toolResultRows.push(row);
    runningMessagesPostDispatch.push({
      role: 'tool',
      content: payload,
      toolCallId: call.id,
    });
  }
  bag.bag.sessions.touch(sessionId);

  // Build runningMessages for the continuation. Includes:
  //   1. system prompt (rebuilt fresh with current grumpy / brief)
  //   2. transcript history minus prior system rows AND the pending
  //      sentinel row (the structured assistant turn replaces it)
  //   3. structured assistant turn (preface + toolCalls)
  //   4. tool result rows we just dispatched
  const grumpy = ctx.settings.get<boolean>('concierge.grumpy_chat', true);
  const folderName = session.folderId
    ? ctx.folders.getById(session.folderId)?.name ?? null
    : null;
  const projectCatalog = session.folderId
    ? resolveProjectCatalog(session.folderId, ctx, bag.bag)
    : null;
  const systemPrompt = buildChatSystemPrompt({
    grumpyMentor: grumpy,
    folderName,
    projectCatalog,
    // Memory injection on the post-approval re-feed too so a turn
    // that resumed from a destructive-tool approval card still
    // carries the user's preferences. Read fresh — same reasoning
    // as the main /messages path above.
    moMemory: bag.bag.moMemory.read().trim() || null,
  });
  // Reconstruct pre-pending history so any tool-calling round before
  // this approval (e.g. the initial `tags_list` reconnaissance) is
  // re-fed with structured `tool_calls` on the assistant turn — same
  // bug as /messages above.
  //
  // We must NOT filter out earlier pending sentinels here. Codex
  // finding #2 in ticket `01KQ2A5HTVG4WYFJE6RNP9D57G`: if the session
  // previously went through one or more destructive approval cycles,
  // each prior `__MO_PENDING_TOOL_APPROVAL__` sentinel must reach
  // `reconstructLLMHistory` so its structured tool_calls + downstream
  // tool result rows get paired back into a valid assistant/tool
  // sequence. Filtering them out leaves the tool result rows orphaned
  // (provider rejects).
  //
  // `slice(0, pendingIdx)` already excludes the CURRENT pending row
  // (the one this approval is resolving) — `runningMessagesPostDispatch`
  // replaces it with the structured assistant turn we just dispatched.
  const transcriptBeforePending = reconstructLLMHistory(
    allMessages.slice(0, pendingIdx),
  );

  const runningMessages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...transcriptBeforePending,
    ...runningMessagesPostDispatch,
  ];

  const result = await runMoChatLoop({
    ctx,
    bag: bag.bag,
    sessionId,
    provider,
    model,
    fallbackModel,
    runningMessages,
  });

  return c.json({
    assistant: result.assistantMsg,
    toolResults: toolResultRows,
    budget: bag.bag.budget.status(),
  });
}

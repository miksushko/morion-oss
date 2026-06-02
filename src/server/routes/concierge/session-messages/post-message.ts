/**
 * POST /api/concierge/sessions/:id/messages
 *
 * User posts into a session. On Pro we also call the provider with the
 * full transcript so the Concierge responds (plain Q&A chat — no tool
 * calls, those only fire during ticks). On Free we reject with 402
 * because the provider burns Pro-budget dollars.
 *
 * Provider errors are caught + surfaced in the assistant message body
 * so the chat doesn't 500 from a transient network flake. The user's
 * message is always persisted first, so a provider failure doesn't
 * lose the outgoing text.
 *
 * Two branches:
 *   1. Workflow-linked session (`session.workflowRunId != null`):
 *      Phase 6 V2 multi-turn chat via `moMessenger.continueChat`.
 *      Mo decides per turn whether to reply or resume the workflow.
 *      Best-effort — falls back to legacy single-turn resume if Mo
 *      throws.
 *   2. Plain folder-scoped or workspace chat: build the system prompt
 *      (memory + project catalog + cleanup-escalation context if
 *      applicable) + reconstruct LLM history + run the chat loop.
 */
import type { Context, Hono } from 'hono';
import {
  buildChatSystemPrompt,
  reconstructLLMHistory,
  type LLMMessage,
} from '../../../../core/concierge/index.js';
import {
  readChatModelFallback,
  readProviderModel,
} from '../../../features/concierge-deps/index.js';
import type { ToolContext } from '../../../tools/types.js';
import { runMoChatLoop } from '../mo-chat-loop.js';
import { sendMessageSchema } from '../schemas.js';
import {
  asHost,
  detectCleanupEscalationContext,
  requireConciergeDeps,
  resolveProjectCatalog,
} from '../shared.js';
import { tryWorkflowResume } from './workflow-resume.js';

export function registerPostMessageRoute(app: Hono, ctx: ToolContext): void {
  app.post('/api/concierge/sessions/:id/messages', (c) =>
    handlePostMessage(c, ctx, c.req.param('id')),
  );
}

async function handlePostMessage(c: Context, ctx: ToolContext, sessionId: string) {
  const bag = requireConciergeDeps(ctx);
  if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
  const session = bag.bag.sessions.get(sessionId);
  if (!session) return c.json({ error: 'not_found' }, 404);
  const body = sendMessageSchema.parse(await c.req.json());

  // Always persist user turn first so a provider throw doesn't lose
  // the outgoing message.
  const userMsg = bag.bag.messages.create({
    sessionId,
    role: 'user',
    content: body.content,
    repliedActionId: body.repliedActionId,
  });
  bag.bag.sessions.touch(sessionId);
  // A user reply clears `needs_human` — they've answered.
  if (session.needsHuman) bag.bag.sessions.setNeedsHuman(sessionId, false);

  // Workflow-linked chat — Phase 6 V2 multi-turn path. Best-effort:
  // if anything throws OR Mo can't decide, fall through to the plain
  // chat loop below so the user still gets a reply.
  if (session.workflowRunId) {
    const workflowResponse = await tryWorkflowResume({
      ctx,
      sessionId,
      session,
      userMsg,
      body,
    });
    if (workflowResponse) return c.json(workflowResponse.body);
  }

  // Pre-check budget before billing a real provider call.
  const budgetStatus = bag.bag.budget.status();
  if (!budgetStatus.withinBudget) {
    const assistantMsg = bag.bag.messages.create({
      sessionId,
      role: 'assistant',
      content:
        'Concierge paused — daily budget exhausted. Resets at UTC midnight.',
    });
    return c.json({ user: userMsg, assistant: assistantMsg, budget: budgetStatus });
  }

  const { provider, model } = readProviderModel(asHost(ctx));
  // `listLatestBySession` not `listBySession` — the chat re-feed must
  // include the user message we JUST inserted above, even when the
  // session has more rows than the cap. Codex finding #3 in ticket
  // `01KQ2A5HTVG4WYFJE6RNP9D57G`. UI/transcript GET continues to use
  // `listBySession` for stable pagination semantics.
  const history = bag.bag.messages.listLatestBySession(sessionId, 500);
  // Mo's voice is a single global toggle (no per-folder override) —
  // lives in `concierge.grumpy_chat` (default true), set via the Ask
  // Mo panel's settings gear.
  const grumpy = ctx.settings.get<boolean>('concierge.grumpy_chat', true);
  const folderName = session.folderId
    ? ctx.folders.getById(session.folderId)?.name ?? null
    : null;
  // Direction X — Checking Corners. If this chat is folder-scoped AND
  // the folder has a fresh brief (<24h), prepend it so Mo answers
  // with pre-digested context. Master kill-switch + per-folder opt-in
  // both gate; null falls through to plain chat prompt.
  const projectCatalog = session.folderId
    ? resolveProjectCatalog(session.folderId, ctx, bag.bag)
    : null;
  // Detect whether this turn is a custom-instruction reply to a
  // pending topic-cleanup escalation. If so, surface the proposer's
  // structured choices to the system prompt so Mo can interpret the
  // user's free-text intent against them. Without this, chat-tier Mo
  // loses the proposal context and can hallucinate "Mo not enabled
  // for this folder" — see dogfood report 2026-05-04.
  const cleanupEscalation = detectCleanupEscalationContext(history, folderName);
  const systemPrompt = buildChatSystemPrompt({
    grumpyMentor: grumpy,
    folderName,
    projectCatalog,
    // Workspace-wide memory — fresh on every turn so user edits (or
    // `mo_remember` writes) take effect immediately without
    // re-opening the session.
    moMemory: bag.bag.moMemory.read().trim() || null,
    cleanupEscalation,
  });
  // Filter out prior system rows from the persisted history — we
  // prepend a fresh one each turn so the tone setting reflects the
  // CURRENT state, not whatever the setting was when the session was
  // first opened.
  //
  // `reconstructLLMHistory` rebuilds structured `tool_calls` on
  // assistant rows that emitted tools in PRIOR rounds. Previously we
  // mapped to plain `{role, content, toolCallId}`, which produced an
  // OpenAI-malformed sequence (tool messages whose preceding
  // assistant had no `tool_calls` field) and Mo "vanished" without a
  // follow-up message. Ticket 01KQ1R97C0GK6KPQF03AFCZ42B round 2.
  const llmMessages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...reconstructLLMHistory(history),
  ];

  const chatFallbackModel = readChatModelFallback(asHost(ctx));
  const result = await runMoChatLoop({
    ctx,
    bag: bag.bag,
    sessionId,
    provider,
    model,
    fallbackModel: chatFallbackModel,
    runningMessages: [...llmMessages] as LLMMessage[],
  });
  return c.json({
    user: userMsg,
    assistant: result.assistantMsg,
    budget: bag.bag.budget.status(),
  });
}


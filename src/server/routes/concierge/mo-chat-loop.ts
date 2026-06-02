/**
 * Mo chat-tier tool-call loop — security-critical helper shared by
 * POST /messages and POST /tool-approve.
 *
 * Returns:
 *   - `{kind: 'final'}` when the model emitted a turn with no tool
 *     calls (regular text reply). The final assistant message is
 *     persisted before return.
 *   - `{kind: 'pending'}` when the model emitted at least one tool
 *     call whose `category === 'delete'`. Persists a sentinel
 *     pending-tool row instead of dispatching. The /tool-approve
 *     endpoint resumes from there once the user clicks Approve / Deny.
 *
 * Provider errors are caught + persisted as a regular assistant text
 * reply ("Mo error: …") so the chat doesn't 500. The user's outgoing
 * message was already persisted by the caller before this helper
 * runs.
 *
 * Security invariant pinned by `tests/concierge-messages-pending-tool.test.ts`:
 * when the model emits a destructive tool call (`isMoApprovalRequired`
 * returns true), the loop MUST persist `__MO_PENDING_TOOL_APPROVAL__`
 * via `formatPendingToolMessage` and return WITHOUT dispatching. The
 * dispatched note must stay alive. Slice 13 of the route-file split
 * (ticket 01KRJYX50FMDQ94V3464T56K5F) extracted this function from
 * `concierge.ts` — pure code-motion, no behaviour change.
 */

import {
  buildMoToolDefinitions,
  chatProgressBus,
  completeWithFallback,
  describeProviderError,
  dispatchMoTool,
  formatPendingToolMessage,
  isMoApprovalRequired,
  MO_ACTOR,
  serializeMoToolResultForChat,
  spendInputFromLLMResponse,
  type ConciergeMessage,
  type GatherProgressEvent,
  type LLMMessage,
  type LLMProvider,
  type LLMToolCall,
  type PendingToolPayload,
} from '../../../core/concierge/index.js';
import { ALL_TOOLS } from '../../tools/index.js';
import type { ToolContext } from '../../tools/types.js';
import {
  CHAT_DESTRUCTIVE_BATCH_SIZE,
  MAX_TOOL_TURNS,
  resolveDestructiveTargetLabel,
  truncatePreview,
} from './shared.js';

export interface MoChatLoopDeps {
  ctx: ToolContext;
  bag: NonNullable<ToolContext['concierge']>;
  sessionId: string;
  provider: LLMProvider;
  model: string;
  fallbackModel: string;
  runningMessages: LLMMessage[];
}

export type MoChatLoopResult =
  | { kind: 'final'; assistantMsg: ConciergeMessage }
  | { kind: 'pending'; assistantMsg: ConciergeMessage };

export async function runMoChatLoop(deps: MoChatLoopDeps): Promise<MoChatLoopResult> {
  const { ctx, bag, sessionId, provider, model, fallbackModel } = deps;
  const moToolDefs = buildMoToolDefinitions(ALL_TOOLS);
  const moCtx = { ...ctx, actor: MO_ACTOR };
  let assistantContent = '';
  let totalCost = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let modelEcho: string | null = model;
  const runningMessages = deps.runningMessages;

  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      const resp = await completeWithFallback(
        provider,
        { model, messages: runningMessages, tools: moToolDefs },
        fallbackModel,
      );
      totalCost += resp.costUsd;
      if (typeof resp.tokensIn === 'number') totalTokensIn += resp.tokensIn;
      if (typeof resp.tokensOut === 'number') totalTokensOut += resp.tokensOut;
      modelEcho = resp.model;

      // Record THIS provider call to the Mo monthly ledger. Per
      // `01KQ1H556RFFKD7WGZE77MEVFQ`: budget source-of-truth is the
      // ledger, not message rows. Each provider call → exactly one
      // ledger row. The final assistantMsg below carries `totalCost`
      // for UI display only — it does NOT get its own ledger row.
      // Slice 4 of 01KRJSTN74FT7VRX6KAA42GGBS plumbs provider /
      // model / token columns through via spendInputFromLLMResponse.
      bag.budget.record(spendInputFromLLMResponse({ kind: 'chat' }, resp));

      // No tool calls → terminal turn. Break with the assistant text
      // (may be empty if the model emitted only a tool call dropped on
      // the last retry — handled below).
      if (!resp.toolCalls.length) {
        assistantContent = resp.content;
        break;
      }

      // Detect destructive tool calls. Anything `category === 'delete'`
      // requires user approval before dispatch (Codex finding
      // 01KQ1H5MKPBG7DY0730VRRW178). Pause the loop and persist a
      // sentinel pending-tool row; UI renders it as an approval card.
      //
      // Server-side cap (ticket 01KQ21XVVB7QV20JSE4R7SR1AF):
      // The chat system prompt asks Mo to emit at most CHAT_DESTRUCTIVE_BATCH_SIZE
      // destructive calls per turn. The prompt is best-effort — small
      // models often overshoot. Hard-cap server-side: keep the first
      // K destructive calls + every non-destructive call, drop the
      // overflow, and synthesize tool-result messages for the dropped
      // ones telling Mo "deferred — re-issue next turn after this
      // batch is approved". That way the user never sees a 50-card
      // approval wall, and Mo can resume cleanly.
      const allDestructive = resp.toolCalls.filter((c) =>
        isMoApprovalRequired(c.name, ALL_TOOLS),
      );
      let toolCallsForTurn = resp.toolCalls;
      const deferredIds: string[] = [];
      if (allDestructive.length > CHAT_DESTRUCTIVE_BATCH_SIZE) {
        const keepDestructiveIds = new Set(
          allDestructive.slice(0, CHAT_DESTRUCTIVE_BATCH_SIZE).map((c) => c.id),
        );
        toolCallsForTurn = resp.toolCalls.filter((c) => {
          if (!isMoApprovalRequired(c.name, ALL_TOOLS)) return true;
          if (keepDestructiveIds.has(c.id)) return true;
          deferredIds.push(c.id);
          return false;
        });
      }
      const destructiveCalls = toolCallsForTurn.filter((c) =>
        isMoApprovalRequired(c.name, ALL_TOOLS),
      );
      if (destructiveCalls.length > 0) {
        const destructiveIdSet = new Set(destructiveCalls.map((c) => c.id));
        // If we trimmed the model's output, prepend a note to the
        // approval card preface so the user sees what Mo planned vs.
        // what's queued.
        const trimmedNotice = deferredIds.length
          ? `\n\n_Server cap: showing the first ${CHAT_DESTRUCTIVE_BATCH_SIZE} destructive calls. ${deferredIds.length} more will be re-issued in the next batch after you approve._`
          : '';
        const payload: PendingToolPayload = {
          preface: (resp.content ?? '') + trimmedNotice,
          toolCalls: toolCallsForTurn.map((c: LLMToolCall) => ({
            id: c.id,
            name: c.name,
            argumentsJson: c.argumentsJson,
            // Resolve the target's title/name on the server only for
            // destructive calls — that's what the user sees in the
            // approval card. ULID alone is useless for confirming.
            displayLabel: destructiveIdSet.has(c.id)
              ? resolveDestructiveTargetLabel(c.name, c.argumentsJson, ctx)
              : undefined,
          })),
          destructiveCallIds: destructiveCalls.map((c) => c.id),
          model: resp.model,
        };
        const pendingMsg = bag.messages.create({
          sessionId,
          role: 'assistant',
          content: formatPendingToolMessage(payload),
          costUsd: resp.costUsd,
          tokensIn: resp.tokensIn,
          tokensOut: resp.tokensOut,
          model: resp.model,
        });
        bag.sessions.touch(sessionId);
        return { kind: 'pending', assistantMsg: pendingMsg };
      }

      // Non-destructive turn — dispatch all tool calls inline (existing
      // path). Persist a readable assistant summary row first.
      const toolCallSummary = resp.toolCalls
        .map((t) => `- ${t.name}(${truncatePreview(t.argumentsJson)})`)
        .join('\n');
      bag.messages.create({
        sessionId,
        role: 'assistant',
        content: resp.content
          ? `${resp.content}\n\n(querying workspace:\n${toolCallSummary})`
          : `(querying workspace:\n${toolCallSummary})`,
        costUsd: resp.costUsd,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        model: resp.model,
      });
      bag.sessions.touch(sessionId);

      runningMessages.push({
        role: 'assistant',
        content: resp.content,
        toolCalls: resp.toolCalls,
      });
      for (const call of resp.toolCalls) {
        // Wire chat-progress side channel for tools that support it
        // (currently only `mo_get_context`'s gather pipeline). The
        // SSE endpoint above subscribes to the bus per session; here
        // we publish events with the toolCallId so the UI can route
        // to the right inflight bubble.
        const dispatchCtx: typeof moCtx =
          call.name === 'mo_get_context'
            ? {
                ...moCtx,
                _chatProgress: {
                  onGatherProgress: (event: GatherProgressEvent) => {
                    chatProgressBus.publish(sessionId, {
                      toolCallId: call.id,
                      toolName: call.name,
                      ts: Date.now(),
                      event,
                    });
                  },
                },
              }
            : moCtx;
        const result = await dispatchMoTool(
          ALL_TOOLS,
          { name: call.name, argumentsJson: call.argumentsJson },
          dispatchCtx,
        );
        // See destructive-resolve path: same chat-budget enforcement.
        const { json: payload } = serializeMoToolResultForChat(call.name, result);
        bag.messages.create({
          sessionId,
          role: 'tool',
          content: payload,
          toolCallId: call.id,
          model: resp.model,
        });
        runningMessages.push({
          role: 'tool',
          content: payload,
          toolCallId: call.id,
        });
      }
    }
    // Drop this session's progress buffer once the loop completes —
    // next user message starts with a clean slate. Listeners (open
    // SSE streams) are notified via their natural event flow; the
    // clear() removes the buffer so a re-subscriber doesn't replay
    // stale events from the prior turn.
    chatProgressBus.clear(sessionId);

    if (!assistantContent) {
      // Loop exited without a final text turn. This happens when the
      // model kept asking for tools right up to MAX_TOOL_TURNS — the
      // user never sees a wrap-up. Instead of the static fallback,
      // ask the provider for ONE more pass with `tools: []` so the
      // model is forced to write text. Cost: one extra completion per
      // overflow case (rare). Ticket 01KQ21XVVB7QV20JSE4R7SR1AF.
      let summarized = false;
      try {
        const summary = await completeWithFallback(
          provider,
          { model, messages: runningMessages, tools: [] },
          fallbackModel,
        );
        if (summary.content && summary.content.trim()) {
          assistantContent = summary.content;
          totalCost += summary.costUsd;
          if (typeof summary.tokensIn === 'number') totalTokensIn += summary.tokensIn;
          if (typeof summary.tokensOut === 'number') totalTokensOut += summary.tokensOut;
          modelEcho = summary.model;
          summarized = true;
          // Same ledger discipline as the main loop: this overflow-
          // recovery pass is one more provider call → one more ledger
          // row. Without it the final summary would be unbilled.
          bag.budget.record(spendInputFromLLMResponse({ kind: 'chat' }, summary));
        }
      } catch {
        // Provider unavailable — fall through to static fallback.
      }
      if (!summarized) {
        assistantContent =
          'I pulled context from your workspace but couldn\'t wrap it up. Try asking again more specifically.';
      }
    }
  } catch (err) {
    // Surface fetch-cause when present (DNS / TLS / connection) so the
    // user sees "fetch failed (ENOTFOUND api.groq.com)" instead of a
    // bare "fetch failed" — actionable vs. opaque. Also log to server
    // console with the full Error for ops-side debugging.
    // eslint-disable-next-line no-console
    console.error('[concierge] Mo chat loop failed', err);
    assistantContent = `Mo error: ${describeProviderError(err).slice(0, 200)}`;
  }

  const assistantMsg = bag.messages.create({
    sessionId,
    role: 'assistant',
    content: assistantContent,
    costUsd: totalCost,
    tokensIn: totalTokensIn || null,
    tokensOut: totalTokensOut || null,
    model: modelEcho,
  });
  bag.sessions.touch(sessionId);
  return { kind: 'final', assistantMsg };
}

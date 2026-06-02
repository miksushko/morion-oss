/**
 * Phase 6 V2 multi-turn chat for workflow-linked sessions (Morion ticket
 * 01KRG02E2SV2F9F3PZ6TPDDCNA, Commit C, 2026-05-13). Workflow-linked
 * chat sessions are multi-turn between user and Mo. Mo decides per turn
 * whether the conversation has reached actionable state (resume the
 * workflow) or needs another clarifying exchange (reply, keep waiting).
 *
 * Mechanic per user reply in such a session:
 *   1. Build chat history (oldest → newest).
 *   2. Call moMessenger.continueChat — returns
 *      `{action: 'reply' | 'resume', text}`.
 *   3. `reply` → post Mo's text as the next assistant message, return.
 *      Session stays paused; user can reply again.
 *   4. `resume` → post Mo's summary as the final assistant message,
 *      then fire dispatcher.resumeFromHumanGate with `text` as the
 *      conversation summary (becomes reopen-context for the next
 *      mo_stage).
 *
 * Replaces the Phase 5 single-turn path that resumed on the FIRST user
 * reply unconditionally. That path bypassed Mo's role as the
 * conversational lead — a vague "ок" or "do whatever" would resume the
 * workflow with no actionable context. Now Mo asks for specifics until
 * the user gives concrete input.
 *
 * Returns the response body to short-circuit the main handler when the
 * workflow path handled the turn, or `null` to fall through to the
 * normal chat loop (Mo couldn't decide, exception thrown, etc.).
 */
import { buildAutoCodeDispatcher } from '../../../features/auto-code-factory/index.js';
import type {
  ConciergeMessage,
  ConciergeSession,
} from '../../../../core/concierge/types.js';
import type { ToolContext } from '../../../tools/types.js';
import { asHost, requireConciergeDeps } from '../shared.js';
import type { sendMessageSchema } from '../schemas.js';
import type { z } from 'zod';

export async function tryWorkflowResume({
  ctx,
  sessionId,
  session,
  userMsg,
  body,
}: {
  ctx: ToolContext;
  sessionId: string;
  session: ConciergeSession;
  userMsg: ConciergeMessage;
  body: z.infer<typeof sendMessageSchema>;
}): Promise<{ body: unknown } | null> {
  const bag = requireConciergeDeps(ctx);
  if (!bag.ok || !session.workflowRunId) return null;
  try {
    const { buildProductionMoMessengerDispatcher } = await import(
      '../../../../core/auto-code/workflows/mo-messenger-dispatcher.js'
    );
    const { resolveGatherProvider, resolveGatherModels } = await import(
      '../../../features/concierge-deps/index.js'
    );
    const messenger = buildProductionMoMessengerDispatcher({
      resolveProvider: () => resolveGatherProvider(asHost(ctx))?.provider ?? null,
      resolveModel: () => resolveGatherModels(asHost(ctx))?.subagentModel ?? null,
      budget: bag.bag.budget,
    });
    // Find the linked ticket for prompt context.
    const { WorkflowRunsRepository } = await import(
      '../../../../core/auto-code/workflows/runs-repository.js'
    );
    const runsRepo = new WorkflowRunsRepository(ctx.db);
    const run = runsRepo.getRun(session.workflowRunId);
    const ticket = run ? ctx.notes.getById(run.ticketId) : null;
    // Phase 6 V2 (Morion ticket 01KRG02E2SV2F9F3PZ6TPDDCNA, 2026-05-13)
    // — once the run resumed (left `paused_ask_user`) OR reached
    // terminal, this chat session is "closed" from a workflow POV.
    // Subsequent user messages here are not chat turns Mo should react
    // to — the agent already took the ticket back. Deterministic
    // Mo-curated deflection (no LLM call) tells the user where to go
    // next.
    if (
      run &&
      run.status !== 'paused_ask_user' &&
      (run.status === 'running' ||
        run.status === 'pending' ||
        run.status === 'done' ||
        run.status === 'failed' ||
        run.status === 'cancelled')
    ) {
      const phrase =
        run.status === 'running' || run.status === 'pending'
          ? "I've already passed your answer to the agent — it's back at work on the ticket. If you want to change direction, drag the ticket out of `doing` (or hit Cancel in the auto-code drawer) and re-trigger it from a fresh state."
          : run.status === 'done'
            ? "The agent already finished this run — check the ticket activity feed or the auto-code drawer for the result. If you want changes, open a new run."
            : run.status === 'failed'
              ? "This run failed and is no longer waiting on you. Look at the ticket for the failure reason, then re-trigger if you want to retry."
              : "This run was cancelled. Re-trigger the ticket from a fresh state if you want to retry.";
      const declineMsg = bag.bag.messages.create({
        sessionId,
        role: 'assistant',
        content: phrase,
      });
      // needsHuman stays false — this chat is closed business.
      return {
        body: {
          user: userMsg,
          assistant: declineMsg,
          workflowChatTurn: 'closed',
          runStatus: run.status,
        },
      };
    }
    // Pull all chat history (user already-inserted reply included).
    const historyRaw = bag.bag.messages.listLatestBySession(sessionId, 500);
    const chatHistory = historyRaw
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
    // Read workflow stage's guidance from the human_gate stage row.
    let guidance: string | undefined = undefined;
    if (run) {
      const stages = runsRepo.listStagesForRun(run.id);
      const humanGateRow = stages
        .filter((s) => s.stageKind === 'human_gate' && s.status === 'running')
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      if (humanGateRow?.output && typeof humanGateRow.output === 'object') {
        const g = (humanGateRow.output as Record<string, unknown>).guidance;
        if (typeof g === 'string') guidance = g;
      }
    }
    const decision = await messenger.continueChat({
      ticketTitle: ticket?.title ?? '',
      ticketBody: ticket?.body ?? '',
      chatHistory,
      guidance,
      folderId: session.folderId,
    });
    if (!decision.ok) {
      // Mo couldn't decide — log + fall through to single-turn legacy
      // resume so the user isn't stuck.
      console.warn(
        `[concierge] continueChat failed (${decision.error}: ${decision.message}); falling back to legacy single-turn resume`,
      );
      const dispatcher = await buildAutoCodeDispatcher(ctx);
      if (dispatcher.resumeFromHumanGate) {
        void dispatcher.resumeFromHumanGate({
          runId: session.workflowRunId,
          userReply: body.content,
        });
        const ack = bag.bag.messages.create({
          sessionId,
          role: 'assistant',
          content:
            "▶️ Got it — resuming the workflow with your answer. (Mo couldn't run the chat decision check; using legacy resume.)",
        });
        return {
          body: { user: userMsg, assistant: ack, workflowResumed: true },
        };
      }
    }
    if (decision.ok) {
      // Post Mo's user-facing message (always present). For 'reply'
      // actions this is the next chat turn; for 'resume' it's a short
      // ack ("Picking up the work now"). The machine-readable
      // `resumeSummary` (only on 'resume') is NOT posted to chat — it
      // goes to the runner as reopen-context for the next mo_stage.
      const assistantMsg = bag.bag.messages.create({
        sessionId,
        role: 'assistant',
        content: decision.userMessage,
      });
      if (decision.action === 'reply') {
        // Multi-turn continues — re-mark needs_human so the sidebar
        // badge keeps flagging this session.
        bag.bag.sessions.setNeedsHuman(sessionId, true);
        return {
          body: {
            user: userMsg,
            assistant: assistantMsg,
            workflowChatTurn: 'reply',
          },
        };
      }
      // action === 'resume' → fire the actual workflow resume.
      // `resumeSummary` is the actionable context for the next
      // mo_stage; fall back to user-facing message if (for whatever
      // reason) Mo didn't emit a summary.
      const reopenContext =
        decision.resumeSummary ?? decision.userMessage;
      const dispatcher = await buildAutoCodeDispatcher(ctx);
      if (dispatcher.resumeFromHumanGate) {
        void dispatcher.resumeFromHumanGate({
          runId: session.workflowRunId,
          userReply: reopenContext,
        });
        return {
          body: {
            user: userMsg,
            assistant: assistantMsg,
            workflowChatTurn: 'resume',
            workflowResumed: true,
          },
        };
      }
    }
  } catch (err) {
    // Best-effort — if anything throws, fall through to the regular
    // Mo chat loop so the user still gets a reply.
    console.warn(
      '[concierge] workflow resume hook threw',
      (err as Error).message,
    );
  }
  return null;
}

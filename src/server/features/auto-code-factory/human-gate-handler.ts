import type { ToolContext } from '../../tools/types.js';
import type {
  HumanGateHandler,
  HumanGateHandlerResult,
} from '../../../core/auto-code/workflows/runner.js';
import type { MoMessengerDispatcher } from '../../../core/auto-code/workflows/mo-messenger-dispatcher.js';
import type { WorkflowRunsRepository } from '../../../core/auto-code/workflows/runs-repository.js';
import { AUTO_CODE_ACTOR } from '../../../core/auto-code/actor-constants.js';
import { extractQuestionBlock } from '../../../core/auto-code/workflows/human-gate-verbatim.js';

/**
 * Phase 5 MVP (ticket 01KRFT0742GY480WFJTAW02Z05) — production
 * human_gate handler. Creates the Ask Mo chat session linked to
 * the workflow run, posts Mo's question as the opening assistant
 * message, posts a visible footprint comment on the ticket pointing
 * the user at the chat. The runner persists the pause state
 * (`workflow_runs.paused_session_id`) after the handler returns
 * `{ok: true, sessionId}`.
 *
 * When the Mo messenger dispatcher is wired (Phase 6 V2) the handler
 * delegates opening composition to Mo (recent comments + prior
 * stage outputs → context+question). Falls back to the stage's
 * static `guidance` text — or a sparse honest pause message — when
 * Mo isn't available (no provider key / budget exhausted).
 */
export function buildHumanGateHandler(deps: {
  toolCtx: ToolContext;
  runsRepo: WorkflowRunsRepository;
  moMessengerDispatcher: MoMessengerDispatcher | null;
}): HumanGateHandler {
  const { toolCtx, runsRepo, moMessengerDispatcher } = deps;
  return async (args): Promise<HumanGateHandlerResult> => {
    if (!toolCtx.concierge) {
      return {
        ok: false,
        reason: 'concierge_not_wired: cannot create Ask Mo session',
      };
    }
    try {
      // Phase 6 V2 — Mo composes the chat opening from full ticket
      // context. When the messenger isn't wired (Mo provider not
      // configured / budget exhausted), fall back to a short
      // honest message that points the user at the ticket activity
      // feed for context.
      let summary: string | null = null;
      let question: string | null = null;

      // "Mo = router, not narrator":
      // if the agent ended its turn with a `QUESTION:` block, that is
      // the authoritative text the user must see — post it VERBATIM,
      // not Mo's paraphrase. Mo (when available) only writes a
      // one-line context preamble; the agent's own words stand.
      const stageRowsAll = runsRepo.listStagesForRun(args.runId);
      const lastAgentSummary = [...stageRowsAll]
        .reverse()
        .map((s) => {
          const o = (s.output ?? null) as Record<string, unknown> | null;
          return s.stageKind === 'cli_agent' && o && typeof o.summary === 'string'
            ? (o.summary as string)
            : null;
        })
        .find((s): s is string => s !== null) ?? null;
      const verbatimQuestion = extractQuestionBlock(lastAgentSummary);

      if (moMessengerDispatcher) {
        // Pull recent comments + prior stage outputs as Mo's input.
        const noteRow = toolCtx.notes.getById(args.ticketId);
        const recentCommentsList = toolCtx.comments.list(args.ticketId, {
          limit: 20,
        });
        // Format: newest-first, role-tagged, brief.
        const recentComments = recentCommentsList.items
          .map(
            (c) => `[${c.actor}] ${c.body.replace(/\s+/g, ' ').slice(0, 300)}`,
          )
          .join('\n');
        // Prior stage outputs come from workflow_run_stages.output_json.
        const stageRows = runsRepo.listStagesForRun(args.runId);
        const priorStageOutputs = stageRows
          .filter((s) => s.output)
          .map((s) => {
            const o = s.output as Record<string, unknown>;
            const summaryText =
              typeof o.summary === 'string'
                ? o.summary
                : typeof o.comment === 'string'
                  ? o.comment
                  : null;
            return summaryText
              ? `## ${s.stageIdInGraph} (${s.stageKind}, ${s.status})\n${summaryText.slice(0, 800)}`
              : null;
          })
          .filter((s): s is string => s !== null)
          .join('\n\n');
        const composed = await moMessengerDispatcher.composeOpening({
          ticketTitle: noteRow?.title ?? args.ticketTitle,
          ticketBody: noteRow?.body ?? '',
          recentComments,
          priorStageOutputs,
          guidance: args.guidance,
          folderId: args.folderId || null,
        });
        if (composed.ok) {
          summary = composed.summary;
          question = composed.question;
        } else {
          // Mo couldn't compose — log + fall through to guidance-or-static path.
          console.warn(
            `[auto-code humanGateHandler] Mo compose failed: ${composed.error}: ${composed.message}`,
          );
        }
      }
      const session = toolCtx.concierge.sessions.create({
        folderId: args.folderId || null,
        title: `Workflow question — ${args.ticketTitle.slice(0, 60)}`,
        openedBy: 'concierge',
        needsHuman: true,
        workflowRunId: args.runId,
      });
      if (verbatimQuestion) {
        // Verbatim path: a one-line context preamble (Mo's composed
        // `summary` when available, else a deterministic lead), then
        // the agent's OWN question, unedited. The agent's words are
        // the second message so the user reads them as the ask.
        const preamble =
          (summary && summary.trim().length > 0
            ? summary.trim()
            : `The agent working on "${args.ticketTitle}" paused to ask you a question:`);
        toolCtx.concierge.messages.create({
          sessionId: session.id,
          role: 'assistant',
          content: preamble,
        });
        toolCtx.concierge.messages.create({
          sessionId: session.id,
          role: 'assistant',
          content: verbatimQuestion,
        });
        // The footprint + logging below key off `question`; use the
        // verbatim text so the ticket excerpt matches what was asked.
        question = verbatimQuestion;
      } else if (summary && question) {
        // No QUESTION marker — Mo's composed opening. Two messages so
        // the chat shows context-then-question structure naturally.
        toolCtx.concierge.messages.create({
          sessionId: session.id,
          role: 'assistant',
          content: summary,
        });
        toolCtx.concierge.messages.create({
          sessionId: session.id,
          role: 'assistant',
          content: question,
        });
      } else {
        // Fallback path — Mo wasn't available. Post workflow
        // author's guidance if any, else a sparse honest message.
        const fallback =
          args.guidance && args.guidance.trim().length > 0
            ? args.guidance.trim()
            : `Mo paused this run for input. Check the latest ticket activity for context, then reply here with how to proceed.`;
        toolCtx.concierge.messages.create({
          sessionId: session.id,
          role: 'assistant',
          content: fallback,
        });
      }
      // Footprint comment on the ticket (kanban view discovers
      // pause from outside the chat list).
      const footprintExcerpt = question
        ? question.slice(0, 280)
        : (args.guidance ?? '').slice(0, 280) ||
          'Mo needs input — open the chat to continue.';
      toolCtx.comments.create(
        args.ticketId,
        `⏸️ Mo is waiting for your answer.\n\n> ${footprintExcerpt}${footprintExcerpt.length >= 280 ? '…' : ''}\n\nOpen the chat to reply: [Ask Mo session](morion://concierge/sessions/${session.id})`,
        AUTO_CODE_ACTOR,
        null,
      );
      return { ok: true, sessionId: session.id };
    } catch (err) {
      return {
        ok: false,
        reason: `human_gate_handler_threw: ${(err as Error).message ?? String(err)}`,
      };
    }
  };
}

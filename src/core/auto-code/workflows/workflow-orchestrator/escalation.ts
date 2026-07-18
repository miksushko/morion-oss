/**
 * Workflow orchestrator — escalation chat + attached-handle factory +
 * recent-comments block builder.
 *
 * Extracted from src/core/auto-code/workflows/workflow-orchestrator.ts
 * on 2026-05-16. Grouped because all three are small (≤45 LOC each)
 * and share the same "reach into deps without owning state" shape.
 */
import type { RunHandle } from '../runner.js';
import type { WorkflowOrchestrator as WO } from '../workflow-orchestrator.js';
import { formatActor, snippet } from './helpers.js';

export function makeAttachedHandle(orch: WO, runId: string): RunHandle {
  return {
    runId,
    deduped: true,
    awaitTerminal: async () => {
      for (;;) {
        const row = orch.deps.runsRepo.getRun(runId);
        if (!row) throw new Error(`run ${runId} vanished`);
        if (
          row.status === 'done' ||
          row.status === 'failed' ||
          row.status === 'cancelled'
        ) {
          return row;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    },
    cancel: async (reason) => {
      await orch.deps.runner.cancel(runId, reason ?? 'parent_handle_cancel');
    },
  };
}

export async function openEscalationChat(orch: WO, 
  folderId: string,
  taskId: string,
  reviewerReason: string,
): Promise<string | null> {
  if (!orch.deps.sessions || !orch.deps.messages) return null;
  try {
    const task = orch.deps.notes.getById(taskId);
    const titleStem = task?.title ?? taskId;
    const session = orch.deps.sessions.create({
      folderId,
      title: `Auto-code paused: ${snippet(titleStem, 80)}`,
      openedBy: 'concierge',
      needsHuman: true,
    });
    const reasonBlock = reviewerReason
      ? `\n\n**Reviewer's reason:**\n\n\`\`\`\n${snippet(reviewerReason, 2_000)}\n\`\`\``
      : '';
    const body = [
      `Auto-code paused **${snippet(titleStem, 120)}** (\`${taskId}\`) and bounced it to backlog with the \`auto-code-paused\` tag.`,
      '',
      `**Reason:** reviewer escalated`,
      reasonBlock,
      '',
      'What would you like me to do?',
      '- Re-trigger the loop (drag the ticket back into `todo`)',
      '- Edit the ticket spec to clarify scope / acceptance criteria',
      '- Take over the work yourself',
      '',
      "Reply here with whichever option fits — I'll wait for your call before touching it again.",
    ].join('\n');
    orch.deps.messages.create({
      sessionId: session.id,
      role: 'assistant',
      content: body,
      costUsd: 0,
    });
    return session.id;
  } catch (err) {
    console.error('[workflow-orchestrator] openEscalationChat failed:', err);
    return null;
  }
}

/** One comment body's share of the prompt — a single pasted log dump
 *  must not drown the other 19 comments. */
const COMMENT_BODY_CAP = 1_000;

export function buildRecentCommentsBlock(orch: WO, taskId: string): string {
  // "Mo = router, not narrator" (2026-07-14): ticket comments are
  // a shared
  // communication channel between the user, the agents, and Mo —
  // auto-code's own comments (Mo decision traces, stage summaries,
  // pause / sink wrap-ups) are context the next stage or run SHOULD
  // see, not self-talk to hide. The old AUTO_CODE_ACTOR filter (which
  // existed because a stale "Auto-code paused: no API key" comment
  // biased the next mo_start toward reject) is replaced by
  // deterministic caps: newest `recentCommentsLimit` comments
  // regardless of actor, each body clipped to COMMENT_BODY_CAP. The
  // reject-bias concern is now handled by the decision role's
  // ground-truth + evidence-citing rules instead of by hiding history.
  const page = orch.deps.comments.list(taskId, {
    limit: orch.recentCommentsLimit,
  });
  if (page.items.length === 0) return '(no recent comments)';
  return page.items
    .slice(0, orch.recentCommentsLimit)
    .reverse()
    .map((c) => {
      const body =
        c.body.length > COMMENT_BODY_CAP
          ? `${c.body.slice(0, COMMENT_BODY_CAP)}… [comment truncated]`
          : c.body;
      return `• ${formatActor(c.actor)}: ${body}`;
    })
    .join('\n');
}

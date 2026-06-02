/**
 * Workflow orchestrator — escalation chat + attached-handle factory +
 * recent-comments block builder.
 *
 * Extracted from src/core/auto-code/workflows/workflow-orchestrator.ts
 * on 2026-05-16. Grouped because all three are small (≤45 LOC each)
 * and share the same "reach into deps without owning state" shape.
 */
import { AUTO_CODE_ACTOR } from '../../actor-constants.js';
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

export function buildRecentCommentsBlock(orch: WO, taskId: string): string {
  // Pull more than `recentCommentsLimit` since we filter out
  // auto-code's own self-talk below — without the over-fetch a
  // ticket with mostly prior auto-code paused comments would
  // surface as "(no recent comments)" even when the user left
  // real guidance under them.
  const page = orch.deps.comments.list(taskId, {
    limit: orch.recentCommentsLimit * 3,
  });
  if (page.items.length === 0) return '(no recent comments)';
  // Filter out comments posted BY auto-code itself (kanban moves,
  // failure summaries, Mo decision traces, sink wrap-ups). Re-
  // dragging a ticket = user wants a fresh attempt; resurfacing
  // "Auto-code paused. No API key found..." in Mo's recent-comments
  // context biases the next mo_start toward another reject decision
  // even after the user fixed the underlying problem. The user's
  // own comments + comments by OTHER mcp actors (mo, claude code,
  // etc) stay visible — those carry real instruction / guidance.
  const userVisible = page.items.filter((c) => c.actor !== AUTO_CODE_ACTOR);
  if (userVisible.length === 0) return '(no recent comments)';
  return userVisible
    .slice(0, orch.recentCommentsLimit)
    .reverse()
    .map((c) => `• ${formatActor(c.actor)}: ${c.body}`)
    .join('\n');
}

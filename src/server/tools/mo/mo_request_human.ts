import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import { redactSecrets } from '../../../core/concierge/redact.js';
import { requireMoEnabledForFolder } from './gate.js';
import { buildCreatedReceipt, type MoReceipt, type ReceiptEntry } from './receipt.js';

/**
 * Phase 4 (deterministic part) — `mo_request_human`.
 *
 * The "I'm stuck, I need a human" durable signal. The full chat-loop
 * "block until the user answers" is non-trivial (MCP is request /
 * response so the agent can't sleep inside a tool call), and that
 * version waits for proper chat-loop integration. This deterministic
 * cut delivers the durable + visible-to-user piece NOW:
 *
 *   - If `taskId` is provided → posts a comment on the task tagged
 *     "AWAITING HUMAN" with the agent's question. User sees it in
 *     the task's activity feed; replies via the existing comment UI.
 *   - Otherwise → creates a backlog kanban card in `folderId` titled
 *     "Mo needs human input: <one-line>" with the question body.
 *     User sees it on the board.
 *
 * Both surfaces are fully audited (`actor=mcp:*`) and revertible via
 * the "What Mo did" Settings panel — no special storage, no new
 * table, just the canonical comment / kanban primitives.
 *
 * The agent itself is responsible for telling its own user "I asked
 * Mo to escalate to you, check Morion." MCP doesn't have a server →
 * client push channel, so polling is on the agent.
 */
export const moRequestHumanTool = defineTool({
  name: 'mo_request_human',
  category: 'create',
  // Surfaces in the activity feed loudly — flag as destructive so MCP
  // clients that highlight destructive ops give the user visibility.
  annotations: { destructiveHint: true },
  description:
    "Escalate to the human user. Posts a durable, visible request that the user can answer in Morion. With `taskId`: comments on the task tagged AWAITING HUMAN. Without: creates a backlog kanban card in the folder titled 'Mo needs human input: <…>'. Requires the folder to have Mo enabled. Note: MCP has no server-push, so the agent must tell its own user separately to check Morion — this tool only durably records the request.",
  inputShape: {
    folderId: z.string().min(1).describe('Required folder id where the question lives. Mo writes never fall back to the unfiled bucket.'),
    question: z.string().min(1).describe("The one-paragraph question the human needs to answer. Be specific about what answer would unblock you."),
    taskId: z.string().optional().describe('Optional source task this question is about. When set, the question is posted as a comment on the task instead of as a new backlog card.'),
    urgency: z.enum(['blocking', 'fyi']).optional().describe("'blocking' (default) labels the request as halting agent work; 'fyi' marks it as informational."),
  },
  async handler(input, ctx): Promise<MoReceipt | typeof ACCESS_DENIED | { error: string; reason?: string; message?: string }> {

    const moGate = requireMoEnabledForFolder(ctx, input.folderId);
    if (moGate) return moGate;

    const folder = ctx.folders.getById(input.folderId);
    if (!folder) {
      return { error: 'folder_not_found', message: `No folder with id ${input.folderId}.` };
    }

    const urgency = input.urgency ?? 'blocking';
    const headerLabel = urgency === 'blocking' ? '🚨 AWAITING HUMAN' : 'ℹ️ FYI — human input requested';

    // Comment-on-task path ------------------------------------------------
    if (input.taskId !== undefined) {
      const task = ctx.notes.getById(input.taskId);
      if (!task) {
        return { error: 'task_not_found', message: `No note with id ${input.taskId}.` };
      }
      if (task.folderId !== input.folderId) {
        return {
          error: 'task_folder_mismatch',
          message: `Task lives in a different folder. Either pass that folderId or omit taskId.`,
        };
      }
      if (!canPerform('update', ctx, { kind: 'note', noteId: input.taskId })) {
        return ACCESS_DENIED;
      }

      const redacted = redactSecrets(input.question);
      const warnings: string[] = [];
      if (redacted.hits > 0) {
        warnings.push(
          `Redacted ${redacted.hits} possible secret(s) from your question before saving.`,
        );
      }
      const body = `**${headerLabel}** (Mo on behalf of \`${ctx.actor}\`)\n\n${redacted.text}`;
      const comment = ctx.comments.create(input.taskId, body, ctx.actor, null);
      if (!comment) {
        return { error: 'comment_failed', message: 'Failed to post the human-request comment.' };
      }

      return buildCreatedReceipt({
        wrote: [{ kind: 'comment', id: comment.id, action: 'commented' }],
        body: redacted.text,
        reason: `Posted ${urgency} human-input request as a comment on task \`${input.taskId}\` in folder "${folder.name}". The user will see it in the task's activity feed; tell your own user to check Morion.`,
        warnings,
      });
    }

    // New backlog card path -----------------------------------------------
    if (!canPerform('create', ctx, { kind: 'newNote', folderId: input.folderId })) {
      return ACCESS_DENIED;
    }

    const trimmed = input.question.trim();
    const titleLine = trimmed.split('\n')[0].slice(0, 80);
    const cardBody = [
      `# Mo needs human input: ${titleLine}`,
      '',
      `**${headerLabel}** (Mo on behalf of \`${ctx.actor}\`)`,
      '',
      trimmed,
    ].join('\n');
    const redacted = redactSecrets(cardBody);
    const warnings: string[] = [];
    if (redacted.hits > 0) {
      warnings.push(
        `Redacted ${redacted.hits} possible secret(s) from your question before saving.`,
      );
    }
    const isMcp = ctx.actor.startsWith('mcp:');
    const card = ctx.notes.create(
      {
        body: redacted.text,
        folderId: input.folderId,
        status: 'backlog',
        source: isMcp ? ctx.actor : 'user',
      },
      ctx.actor,
    );
    await ctx.indexer.reindex(card);

    const wrote: ReceiptEntry[] = [{ kind: 'note', id: card.id, action: 'created' }];
    return buildCreatedReceipt({
      wrote,
      body: redacted.text,
      reason: `Created ${urgency} human-input backlog card \`${card.id}\` in folder "${folder.name}". The user will see it on the board; tell your own user to check Morion.`,
      warnings,
    });
  },
});

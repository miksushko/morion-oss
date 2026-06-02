/**
 * POST /api/concierge/sessions/:id/quick-action
 *
 * Quick-action click handler. The user clicked a button under an
 * assistant message that carried `quickActions`; we look up the action
 * by id, dispatch its payload to the appropriate consumer (currently
 * only topic-cleanup), and persist a user message carrying the action's
 * label + `repliedActionId` so the UI can collapse used buttons + the
 * chat transcript shows what was done.
 *
 * Idempotency: re-clicking ANY action of the same group (e.g.
 * `bundle:0:use-A`, `bundle:0:keep-all` — both have group key
 * `bundle:0`) is a 409. The UI treats sibling actions as one
 * mutually-exclusive decision, and the server enforces the same
 * contract so a double-click race or a UI bug can't apply two
 * contradictory cleanups (Codex finding 2026-05-03).
 *
 * Atomicity: check + apply + user-message + ack run inside ONE SQLite
 * transaction so the dedup gate sees a consistent view and a partial
 * failure can't leave the DB with the cleanup applied but no
 * replied-action-id row to mark the group as decided.
 */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../../../tools/types.js';
import { requireConciergeDeps } from '../shared.js';

const quickActionSchema = z.object({
  messageId: z.string().min(1),
  actionId: z.string().min(1),
});

export function registerQuickActionRoute(app: Hono, ctx: ToolContext): void {
  app.post('/api/concierge/sessions/:id/quick-action', (c) =>
    handleQuickAction(c, ctx, c.req.param('id')),
  );
}

async function handleQuickAction(c: Context, ctx: ToolContext, sessionId: string) {
  const bag = requireConciergeDeps(ctx);
  if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
  if (
    !ctx.concierge?.moClusters ||
    !ctx.concierge?.moClusterQueue ||
    !ctx.concierge?.moTopicDecisions
  ) {
    return c.json({ error: 'mo_internal_not_wired' }, 501);
  }
  const session = bag.bag.sessions.get(sessionId);
  if (!session) return c.json({ error: 'not_found' }, 404);

  const body = quickActionSchema.parse(await c.req.json());
  const message = bag.bag.messages.getById(body.messageId);
  if (!message || message.sessionId !== sessionId) {
    return c.json({ error: 'message_not_found' }, 404);
  }
  if (!message.quickActions || message.quickActions.length === 0) {
    return c.json({ error: 'message_has_no_actions' }, 400);
  }
  const action = message.quickActions.find((a) => a.id === body.actionId);
  if (!action) {
    return c.json({ error: 'action_not_found' }, 404);
  }

  const { applyCleanupQuickAction } = await import(
    '../../../../core/concierge/index.js'
  );

  // Group key: first two `:`-separated segments of the action id
  // (e.g. `bundle:0:use-A` -> `bundle:0`). The custom-instruction
  // path emits `<group>:custom`, also collapsed by this prefix.
  const groupKey = (id: string): string => {
    const parts = id.split(':');
    return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : id;
  };
  const myGroupKey = groupKey(action.id);

  type RunResult =
    | {
        ok: true;
        user: typeof message;
        assistant: typeof message;
        receipt: ReturnType<typeof applyCleanupQuickAction>;
      }
    | { ok: false; error: string; status: number; message?: string };

  const tx = ctx.db.transaction((): RunResult => {
    // Re-check inside the tx — between request landing and tx start,
    // another in-flight click on the same group might have committed.
    // Group-key match (NOT exact action.id) so any sibling
    // already-applied action blocks this one.
    const repliedRows = bag.bag.messages.listRepliedActionIds(sessionId);
    if (repliedRows.some((rid) => groupKey(rid) === myGroupKey)) {
      return { ok: false, error: 'already_replied', status: 409 };
    }

    let receipt;
    try {
      receipt = applyCleanupQuickAction(
        {
          db: ctx.db,
          clusters: ctx.concierge!.moClusters!,
          clusterQueue: ctx.concierge!.moClusterQueue!,
          decisions: ctx.concierge!.moTopicDecisions!,
        },
        action.payload,
      );
    } catch (err) {
      return {
        ok: false,
        error: 'apply_failed',
        status: 400,
        message: (err as Error).message,
      };
    }

    const userMsg = bag.bag.messages.create({
      sessionId,
      role: 'user',
      content: action.label,
      repliedActionId: action.id,
    });
    bag.bag.sessions.touch(sessionId);
    if (session.needsHuman) bag.bag.sessions.setNeedsHuman(sessionId, false);

    // Acknowledge with an assistant message carrying the receipt
    // summary. Deterministic — no LLM call, no budget hit.
    const assistantMsg = bag.bag.messages.create({
      sessionId,
      role: 'assistant',
      content: `Done. ${receipt.summary}.`,
    });

    return {
      ok: true,
      user: userMsg as unknown as typeof message,
      assistant: assistantMsg as unknown as typeof message,
      receipt,
    };
  });

  const result = tx();
  if (!result.ok) {
    return c.json(
      result.message
        ? { error: result.error, message: result.message }
        : { error: result.error },
      result.status as 400 | 404 | 409,
    );
  }
  return c.json({
    user: result.user,
    assistant: result.assistant,
    receipt: result.receipt,
  });
}

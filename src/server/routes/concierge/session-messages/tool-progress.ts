/**
 * GET /api/concierge/sessions/:id/tool-progress
 *
 * SSE stream of progress events for long-running mo_* tool calls
 * dispatched in this session's chat. Real incident 2026-05-04:
 * `mo_get_context` ran 60+ seconds with the chat UI showing only
 * "Mo is thinking" — user thought it hung. The gather engine
 * already emits Wave-by-Wave progress events; this endpoint pipes
 * them to the UI so it can render "Wave 1: 4/10 sub-Mos done →
 * Wave 2: opening 8 candidates → synthesising" in real time.
 *
 * Mirror of the import.ts SSE pattern. Replays buffered events for
 * subscribers that connect mid-call (likely — UI opens this AFTER
 * posting the message that triggers the dispatch). Closes when the
 * client disconnects (Hono streamSSE wraps cleanup).
 */
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  chatProgressBus,
  type ChatProgressEnvelope,
} from '../../../../core/concierge/index.js';
import type { ToolContext } from '../../../tools/types.js';
import { requireConciergeDeps } from '../shared.js';

export function registerToolProgressRoute(app: Hono, ctx: ToolContext): void {
  app.get('/api/concierge/sessions/:id/tool-progress', (c) =>
    handleToolProgress(c, ctx, c.req.param('id')),
  );
}

function handleToolProgress(c: Context, ctx: ToolContext, sessionId: string) {
  const bag = requireConciergeDeps(ctx);
  if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
  if (!bag.bag.sessions.get(sessionId)) return c.json({ error: 'not_found' }, 404);

  return streamSSE(c, async (sse) => {
    let aborted = false;
    const queue: ChatProgressEnvelope[] = [];
    let resolveWaiter: (() => void) | null = null;

    const listener = (env: ChatProgressEnvelope): void => {
      queue.push(env);
      if (resolveWaiter) {
        const r = resolveWaiter;
        resolveWaiter = null;
        r();
      }
    };

    const sub = chatProgressBus.subscribe(sessionId, listener);

    // Replay buffered events first so a UI that opens this AFTER
    // posting a message still sees what already fired.
    for (const env of sub.replay) {
      if (aborted) break;
      try {
        await sse.writeSSE({
          event: 'progress',
          data: JSON.stringify(env),
        });
      } catch {
        aborted = true;
      }
    }

    // Live loop: drain queue, await next event, drain again. Exits
    // when the client disconnects (sse.writeSSE throws).
    try {
      while (!aborted) {
        while (queue.length > 0 && !aborted) {
          const env = queue.shift()!;
          try {
            await sse.writeSSE({
              event: 'progress',
              data: JSON.stringify(env),
            });
          } catch {
            aborted = true;
            break;
          }
        }
        if (aborted) break;
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve;
        });
      }
    } finally {
      sub.unsubscribe();
    }
  });
}

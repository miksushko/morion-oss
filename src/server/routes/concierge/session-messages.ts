/**
 * Ask Mo chat dispatch + destructive-tool approval surface.
 *
 * Four endpoints — the security-sensitive heart of the concierge:
 *
 * - GET  /api/concierge/sessions/:id/tool-progress   — SSE stream of
 *     gather-progress events for long mo_get_context calls.
 * - POST /api/concierge/sessions/:id/messages         — chat turn:
 *     persist user msg → run mo-chat-loop → return assistant or
 *     pending-tool sentinel.
 * - POST /api/concierge/sessions/:id/quick-action     — topic-cleanup
 *     decision card click; deterministic apply with group-key dedup
 *     in one SQLite transaction.
 * - POST /api/concierge/sessions/:id/tool-approve     — resolve a
 *     pending destructive tool call (approve dispatches +
 *     records result; deny writes user_denied envelope; second
 *     approve = 409 already_resolved).
 *
 * Each route lives in its own file under `session-messages/`. This
 * module is the composer — it preserves Hono registration order so
 * the trie-ordering invariant pinned by
 * `tests/concierge-route-registration.test.ts` is unchanged. The
 * shared chat loop lives in `concierge/mo-chat-loop.ts` — both
 * /messages AND /tool-approve drive it.
 *
 * Originally extracted from `src/server/routes/concierge.ts` (slice
 * 13/N of the route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F);
 * per-route split shipped under ticket 01KRQS98KSN71QDB4MMM5395VN.
 * Security invariant pinned by
 * `tests/concierge-messages-pending-tool.test.ts` +
 * `tests/concierge-messages-quick-actions.test.ts` + tool-approve
 * cases in `tests/concierge-http.test.ts`.
 */

import type { Hono } from 'hono';
import type { ToolContext } from '../../tools/types.js';
import { registerToolProgressRoute } from './session-messages/tool-progress.js';
import { registerPostMessageRoute } from './session-messages/post-message.js';
import { registerQuickActionRoute } from './session-messages/quick-action.js';
import { registerToolApproveRoute } from './session-messages/tool-approve.js';

export function registerSessionMessagesRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  // Registration order matches the original inline order. Don't
  // reorder without checking `tests/concierge-route-registration.test.ts`
  // — Hono trie semantics treat earlier registrations as higher
  // priority for parameterised paths.
  registerToolProgressRoute(app, ctx);
  registerPostMessageRoute(app, ctx);
  registerQuickActionRoute(app, ctx);
  registerToolApproveRoute(app, ctx);
}

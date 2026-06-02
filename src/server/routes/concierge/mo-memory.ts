/**
 * Workspace-wide Mo Memory routes.
 *
 * GET /api/mo/memory  — open on Free (UI renders empty state + CTA).
 * PUT /api/mo/memory  — Pro-gated, max 50k chars, max 50k JSON body.
 *
 * Mo also writes this blob via the `mo_remember` MCP tool with
 * conflict + dedup detection. The UI route and the tool share one
 * `MoMemoryRepository` — read-on-every-Mo-prompt is the contract.
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 2/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../../tools/types.js';
import { requireConciergeDeps } from './shared.js';

const moMemoryUpdateSchema = z.object({
  body: z.string().max(50_000),
});

export function registerMoMemoryRoutes(app: Hono, ctx: ToolContext): void {
  // Workspace-level markdown blob Mo reads on every smart call. User
  // edits via Settings UI; Mo writes via the `mo_remember` MCP tool
  // (with conflict / dedup detection). NO Pro gate on read — surfaces
  // even on Free so the Settings UI can render the empty state with
  // an explanation. Write IS Pro-gated because mutating Mo's behavior
  // is a Pro-feature surface.
  app.get('/api/mo/memory', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    return c.json({ body: bag.bag.moMemory.read() });
  });

  app.put('/api/mo/memory', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    let parsed;
    try {
      parsed = moMemoryUpdateSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: 'invalid_body', message: (err as Error).message }, 400);
    }
    bag.bag.moMemory.write(parsed.body);
    return c.json({ ok: true, body: parsed.body });
  });
}

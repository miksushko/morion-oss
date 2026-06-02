/**
 * Manual Mo-indexing tick trigger.
 *
 * POST /api/concierge/mo-indexing-tick — fires `runMoIndexingTick`
 * inline (synchronous) and returns the resulting summary. Mirrors
 * the `mo_patrol` MCP tool; used by the smoke harness + the future
 * "Patrol now" UI button. Pro-gated like every Mo write surface.
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 3/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import type { ToolContext } from '../../tools/types.js';
import { asHost, requireConciergeDeps } from './shared.js';

export function registerIndexingTickRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  // Manual indexing tick trigger. Runs `runMoIndexingTick` inline +
  // returns the summary so we can verify Tier 1 / Tier 2 / Tier 2.5
  // firing without waiting on the scheduler poll.
  app.post('/api/concierge/mo-indexing-tick', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const { runMoIndexingTick } = await import(
      '../../../core/concierge/mo-indexing-tick.js'
    );
    const { buildMoIndexingDeps } = await import('../../features/concierge-deps/index.js');
    try {
      const deps = buildMoIndexingDeps(asHost(ctx));
      const summary = await runMoIndexingTick(deps);
      return c.json(summary);
    } catch (e) {
      return c.json(
        { error: 'indexing_tick_threw', message: (e as Error).message },
        500,
      );
    }
  });
}

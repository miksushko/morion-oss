/**
 * Mo Patrol Findings acknowledge route.
 *
 * POST /api/concierge/findings/:id/acknowledge — accept / dismiss /
 * snooze a finding emitted by `mo_patrol`. Pro-gated; the finding's
 * folder governs the per-folder Mo gate. Snooze without
 * `snoozeUntilTs` returns 400 to mirror the MCP tool's explicit-
 * input contract.
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 3/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../../tools/types.js';
import { requireConciergeDeps } from './shared.js';

const ackSchema = z.object({
  action: z.enum(['accept', 'dismiss', 'snooze']),
  snoozeUntilTs: z.number().int().nonnegative().optional(),
});

export function registerFindingsRoutes(app: Hono, ctx: ToolContext): void {
  app.post('/api/concierge/findings/:id/acknowledge', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const findingsRepo = ctx.concierge?.moPatrolFindings;
    if (!findingsRepo) {
      return c.json({ error: 'mo_internal_not_wired' }, 501);
    }
    const findingId = c.req.param('id');
    const body = ackSchema.parse(await c.req.json().catch(() => ({})));
    if (body.action === 'snooze' && body.snoozeUntilTs === undefined) {
      return c.json(
        {
          error: 'mo_invalid_input',
          reason: 'snooze_requires_timestamp',
        },
        400,
      );
    }
    const finding = findingsRepo.get(findingId);
    if (!finding) {
      return c.json({ error: 'finding_not_found' }, 404);
    }
    const ok = findingsRepo.setState(findingId, body.action, {
      snoozeUntil: body.snoozeUntilTs,
    });
    if (!ok) {
      return c.json({ error: 'finding_not_found' }, 404);
    }
    const refreshed = findingsRepo.get(findingId);
    return c.json({
      findingId,
      action: body.action,
      state: refreshed?.state,
      snoozeUntil: refreshed?.snoozeUntil,
      stateChangedAt: refreshed?.stateChangedAt,
    });
  });
}

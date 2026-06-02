/**
 * Auto-code workspace budget routes (sub-ticket 01KQEEE1VSGFMH8T5AEXQENJVW).
 *
 * GET /api/auto-code/budget — current monthly spend + cap + Claude
 * auth source ('oauth-max' | 'api-key' | null) so the UI can label
 * the dollar amount as "informational" vs "real cost".
 * PUT /api/auto-code/budget — update the workspace cap (cap=0 acts as
 * a kill-switch; upper bound 10× default protects against typos).
 *
 * Cap lives in workspace settings under `auto_code.monthly_budget_usd`.
 * Spend is summed from `mo_spend_ledger` filtered to the two
 * auto-code kinds (`auto-code-fix` + `auto-code-review`), kept
 * SEPARATE from Mo's chat budget (see CLAUDE.md "auto-code budget
 * envelope is workspace-wide and SEPARATE from Mo's $10 cap").
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 2/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import {
  detectClaudeAuthSource,
  readAutoCodeMonthlyCap,
} from '../../features/auto-code-factory/index.js';
import { AUTO_CODE_MONTHLY_CAP_USD } from '../../../core/concierge/budget.js';
import type { ToolContext } from '../../tools/types.js';
import { requireConciergeDeps } from './shared.js';

export function registerAutoCodeBudgetRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  // Workspace-wide monthly spend tracking + cap. Pro-gated like every
  // other auto-code surface; Free users can't enable auto-code so
  // they don't have a budget surface either.
  app.get('/api/auto-code/budget', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const cap = readAutoCodeMonthlyCap(ctx.settings);
    const authSource = detectClaudeAuthSource();
    const status = bag.bag.budget.autoCodeStatus(cap, authSource);
    return c.json(status);
  });

  app.put('/api/auto-code/budget', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = body?.monthlyCapUsd;
    const cap =
      typeof raw === 'number' && Number.isFinite(raw)
        ? raw
        : typeof raw === 'string'
          ? Number.parseFloat(raw)
          : NaN;
    // Clamp to a sane workspace range. $0 disables auto-code at the
    // budget layer (any spend > 0 → withinBudget=false → no claims),
    // which is a useful "kill switch" affordance. Upper bound is
    // 10x the default so a typo can't accidentally authorise a
    // 5-figure burn.
    if (!Number.isFinite(cap) || cap < 0 || cap > 10 * AUTO_CODE_MONTHLY_CAP_USD) {
      return c.json(
        {
          error: 'cap_out_of_range',
          message: `monthlyCapUsd must be between 0 and ${10 * AUTO_CODE_MONTHLY_CAP_USD}`,
        },
        400,
      );
    }
    ctx.settings.set('auto_code.monthly_budget_usd', cap);
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const authSource = detectClaudeAuthSource();
    return c.json(bag.bag.budget.autoCodeStatus(cap, authSource));
  });
}

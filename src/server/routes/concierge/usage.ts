/**
 * Usage stats HTTP surface (ticket 01KRJSTN74FT7VRX6KAA42GGBS, slice 6).
 *
 * `GET /api/usage?period=current_month|last_month|last_7d|last_30d|all_time`
 *
 * Returns one envelope with everything Settings → Usage tab needs:
 *
 *   - resolved `{from, to}` for the requested period
 *   - total cost + request count over the window
 *   - per-kind / per-provider / per-model / daily breakdown from
 *     `MoSpendLedgerRepository.aggregateByPeriod`
 *   - Mo monthly cap status (so the UI can render the Mo $10 progress
 *     bar from the same payload)
 *   - Auto-code monthly cap status (so the auto-code $50 bar likewise
 *     doesn't need a second roundtrip)
 *
 * Reading the ledger is open on Free — the UI surfaces nothing
 * interesting on a $0 ledger anyway, but a Free user opening the tab
 * should see "no LLM calls yet" rather than a 402 wall. Per-feature
 * gating still applies to mutations elsewhere; this is a pure GET.
 *
 * `all_time` resolves `from = 0`, which works against the existing
 * `created_at` index — SQLite range-scans from the start of the index
 * just as cheaply as from a recent boundary.
 *
 * Period semantics:
 *   - current_month — start of THIS UTC month → now
 *   - last_month    — start of previous UTC month → start of current
 *   - last_7d       — now - 7 days → now
 *   - last_30d      — now - 30 days → now
 *   - all_time      — 0 → now
 */

import type { Hono } from 'hono';
import {
  startOfUtcMonth,
  startOfNextUtcMonth,
} from '../../../core/concierge/index.js';
import {
  AUTO_CODE_MONTHLY_CAP_USD,
  MONTHLY_CAP_USD,
} from '../../../core/concierge/budget.js';
import {
  detectClaudeAuthSource,
  readAutoCodeMonthlyCap,
} from '../../features/auto-code-factory/index.js';
import type { ToolContext } from '../../tools/types.js';
import { requireConciergeDeps } from './shared.js';

export type UsagePeriod =
  | 'current_month'
  | 'last_month'
  | 'last_7d'
  | 'last_30d'
  | 'all_time';

const VALID_PERIODS: ReadonlySet<UsagePeriod> = new Set<UsagePeriod>([
  'current_month',
  'last_month',
  'last_7d',
  'last_30d',
  'all_time',
]);

/**
 * Resolve a period name into `[from, to)` (ms). Exported so tests +
 * other consumers (a future CSV export) can hit the same math without
 * round-tripping through the HTTP layer.
 *
 * `now` is injected so tests can fix a clock; production callers
 * default to wall-clock.
 */
export function resolveUsagePeriod(
  period: UsagePeriod,
  now: number = Date.now(),
): { from: number; to: number } {
  switch (period) {
    case 'current_month':
      return { from: startOfUtcMonth(now), to: now };
    case 'last_month': {
      const currentStart = startOfUtcMonth(now);
      // Walk back into the previous month by 1ms, then snap to its
      // start. Robust across leap-year + DST-free UTC arithmetic.
      const prevStart = startOfUtcMonth(currentStart - 1);
      return { from: prevStart, to: currentStart };
    }
    case 'last_7d':
      return { from: now - 7 * 24 * 60 * 60 * 1000, to: now };
    case 'last_30d':
      return { from: now - 30 * 24 * 60 * 60 * 1000, to: now };
    case 'all_time':
      return { from: 0, to: now };
  }
}

export function registerUsageRoutes(app: Hono, ctx: ToolContext): void {
  app.get('/api/usage', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);

    const rawPeriod = (c.req.query('period') ?? 'current_month') as string;
    if (!VALID_PERIODS.has(rawPeriod as UsagePeriod)) {
      return c.json(
        {
          error: 'invalid_period',
          message: `period must be one of: ${Array.from(VALID_PERIODS).join(', ')}`,
        },
        400,
      );
    }
    const period = rawPeriod as UsagePeriod;
    const now = Date.now();
    const { from, to } = resolveUsagePeriod(period, now);

    const aggregate = bag.bag.moSpendLedger.aggregateByPeriod(from, to);

    // Cap status snapshots — current-month only by design; the cap
    // applies to "this billing window", not to whatever historical
    // period the user selected for the breakdown above.
    const moCap = bag.bag.budget.status(now);
    const autoCodeCap = bag.bag.budget.autoCodeStatus(
      readAutoCodeMonthlyCap(ctx.settings),
      detectClaudeAuthSource(),
      now,
    );

    return c.json({
      period,
      ...aggregate,
      // Always-present caps so a single GET drives both progress bars.
      // The UI doesn't need to re-resolve startOfNextUtcMonth; it's
      // already on `moCap.resetsAt` / `autoCodeCap.resetsAt`.
      moCap,
      autoCodeCap,
      // Surface the upper-bound the PUT route would have allowed, so
      // a "set cap" affordance in the dashboard doesn't have to
      // duplicate the AUTO_CODE_MONTHLY_CAP_USD * 10 magic number.
      // Limits-tab (ticket 01KRNCDK0Y16R8QS8YP2AGSPTF) reads both
      // ceilings to render the input `max` attribute.
      autoCodeCapMaxUsd: 10 * AUTO_CODE_MONTHLY_CAP_USD,
      moCapMaxUsd: 10 * MONTHLY_CAP_USD,
      // Echo so the UI can render "Resets <date>" without recomputing.
      nextMonthResetAt: startOfNextUtcMonth(now),
    });
  });
}

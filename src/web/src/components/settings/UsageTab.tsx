import { useEffect, useState } from 'react';
import { api, type UsagePeriod, type UsageResponse } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatUsd } from './format';
import { CapCard } from './usage/CapCard';
import { DailySpendChart } from './usage/DailySpendChart';
import { PerKindTable } from './usage/PerKindTable';
import { PerProviderTable } from './usage/PerProviderTable';
import { ProviderDashboardLinks } from './usage/ProviderDashboardLinks';
import { TopModelsTable } from './usage/TopModelsTable';
import { TriSplitSummary } from './usage/TriSplitSummary';
import { USAGE_PERIODS } from './usage/usage-meta';

/**
 * Usage stats dashboard (ticket 01KRJSTN74FT7VRX6KAA42GGBS). Sources
 * data from `GET /api/usage?period=...`. Reads-only, open on Free —
 * empty-state renders provider dashboard links + "no calls yet" copy
 * instead of a 402 wall.
 */
export function UsageTab() {
  const [period, setPeriod] = useState<UsagePeriod>('current_month');
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getUsage(period)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold text-foreground">Usage</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          LLM consumption — Mo, indexing, auto-code: requests, tokens,
          and spend by feature / provider / model. Sourced from the
          local spend ledger; cross-check against your provider's
          dashboard if numbers diverge.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Period:</span>
        <div className="flex flex-wrap gap-1">
          {USAGE_PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriod(p.key)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                period === p.key
                  ? 'bg-foreground text-background'
                  : 'border border-border bg-background text-muted-foreground hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          Failed to load usage stats: {error}
        </div>
      )}

      {loading && !data ? (
        <p className="text-sm text-muted-foreground">Loading usage stats…</p>
      ) : data ? (
        <UsageContent data={data} loading={loading} />
      ) : null}
    </div>
  );
}

/**
 * Splits out so the `useState`-heavy parent stays focused on the
 * fetch/transition lifecycle. `loading` flag is forwarded so a
 * period-switch keeps prior data visible (with a subtle fade) instead
 * of flashing back to "Loading…".
 */
function UsageContent({
  data,
  loading,
}: {
  data: UsageResponse;
  loading: boolean;
}) {
  return (
    <div className={cn('flex flex-col gap-6', loading && 'opacity-60')}>
      {/* Total cost — headline number with metered vs included split
          (Claude OAuth Max subscription coverage). */}
      <div className="rounded-md border border-border bg-background/40 p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Total spend
        </div>
        <div className="mt-1 flex items-baseline gap-3">
          <div className="text-2xl font-semibold text-foreground">
            {formatUsd(data.totalCostUsd)}
          </div>
          <div className="text-xs text-muted-foreground">
            {data.requestCount}{' '}
            {data.requestCount === 1 ? 'request' : 'requests'}
          </div>
        </div>
        {data.includedCostUsd > 0 && (
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border/60 pt-3">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Metered
              </div>
              <div className="text-sm font-medium text-foreground">
                {formatUsd(data.meteredCostUsd)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                Real charges that left your account
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Included
              </div>
              <div className="text-sm font-medium text-emerald-600 dark:text-emerald-500">
                {formatUsd(data.includedCostUsd)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                Covered by your Claude Max subscription
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Monthly caps — Mo $10 + Auto-code $50. Always current month
          regardless of breakdown period. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <CapCard
          label="Mo monthly cap"
          subtitle="chat, indexing, gather, topic hygiene"
          spentUsd={data.moCap.spentMonthUsd}
          capUsd={data.moCap.monthlyCapUsd}
          withinBudget={data.moCap.withinBudget}
          resetsAt={data.moCap.resetsAt}
        />
        <CapCard
          label="Auto-code monthly cap"
          subtitle="fix, review, merge-resolve"
          spentUsd={data.autoCodeCap.meteredSpentMonthUsd}
          capUsd={data.autoCodeCap.monthlyCapUsd}
          withinBudget={data.autoCodeCap.withinBudget}
          resetsAt={data.autoCodeCap.resetsAt}
          authSource={data.autoCodeCap.authSource}
          includedUsd={data.autoCodeCap.includedSpentMonthUsd}
        />
      </div>

      <TriSplitSummary perKind={data.perKind} />

      <PerKindTable perKind={data.perKind} />

      <div className="grid gap-3 lg:grid-cols-2">
        <PerProviderTable perProvider={data.perProvider} />
        <TopModelsTable perModel={data.perModel} />
      </div>

      <DailySpendChart daily={data.daily} period={data.period} />

      <ProviderDashboardLinks />
    </div>
  );
}

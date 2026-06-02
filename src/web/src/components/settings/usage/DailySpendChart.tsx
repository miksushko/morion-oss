import type { UsageDaily, UsagePeriod } from '../../../lib/api';
import { formatUsd } from '../format';

/**
 * Vertical bar chart of daily spend, normalised to the highest day.
 * Hidden on `current_month` when fewer than 7 distinct days have data —
 * a 3-bar chart is more confusing than useful. UI gives no answer
 * rather than a misleading one.
 */
export function DailySpendChart({
  daily,
  period,
}: {
  daily: UsageDaily[];
  period: UsagePeriod;
}) {
  if (daily.length === 0) return null;
  if (period === 'current_month' && daily.length < 7) return null;
  const max = Math.max(...daily.map((d) => d.totalCostUsd));
  return (
    <div className="rounded-md border border-border bg-background/40 p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Daily spend
      </div>
      <div className="mt-3 flex h-24 items-end gap-1">
        {daily.map((d) => {
          const pct = max > 0 ? (d.totalCostUsd / max) * 100 : 0;
          return (
            <div
              key={d.date}
              className="flex flex-1 flex-col justify-end"
              title={`${d.date} · ${formatUsd(d.totalCostUsd)} · ${d.requestCount} calls`}
            >
              <div
                className="rounded-sm bg-sky-500/80 transition-all"
                style={{ height: `${Math.max(2, pct)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
        <span>{daily[0]?.date ?? ''}</span>
        <span>{daily[daily.length - 1]?.date ?? ''}</span>
      </div>
    </div>
  );
}

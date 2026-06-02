import type { UsagePerKind } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { formatUsd } from '../format';
import { BUCKET_META } from './usage-meta';
import { sumPerKindByBucket } from './usage-derive';

export function TriSplitSummary({ perKind }: { perKind: UsagePerKind[] }) {
  const { totals, grand } = sumPerKindByBucket(perKind);
  return (
    <div className="rounded-md border border-border bg-background/40 p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Spend by area
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {(['interactive', 'background', 'auto-code'] as const).map((bucket) => {
          const value = totals[bucket];
          const pct = grand > 0 ? (value / grand) * 100 : 0;
          const meta = BUCKET_META[bucket];
          return (
            <div key={bucket}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-foreground">{meta.label}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {meta.description}
                  </span>
                </div>
                <div className="flex items-baseline gap-2 text-muted-foreground">
                  <span className="tabular-nums">{formatUsd(value)}</span>
                  <span className="tabular-nums text-[10px]">
                    {grand > 0 ? `${pct.toFixed(0)}%` : '—'}
                  </span>
                </div>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full transition-all', meta.tone)}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

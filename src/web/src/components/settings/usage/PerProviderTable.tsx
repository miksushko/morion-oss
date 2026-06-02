import type { UsagePerProvider } from '../../../lib/api';
import { formatUsd } from '../format';

export function PerProviderTable({
  perProvider,
}: {
  perProvider: UsagePerProvider[];
}) {
  if (perProvider.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/40 p-4 text-xs text-muted-foreground">
        No provider data yet.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-background/40">
      <div className="border-b border-border px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground">
        By provider
      </div>
      <div className="divide-y divide-border/60">
        {perProvider.map((p, i) => (
          <div
            key={p.provider ?? `(unknown-${i})`}
            className="grid grid-cols-12 items-baseline gap-2 px-4 py-2 text-xs"
          >
            <div className="col-span-6 truncate font-medium text-foreground">
              {p.provider ?? (
                <span className="text-muted-foreground">(not captured)</span>
              )}
            </div>
            <div className="col-span-3 tabular-nums text-foreground">
              {formatUsd(p.totalCostUsd)}
            </div>
            <div className="col-span-3 tabular-nums text-right text-muted-foreground">
              {p.requestCount} {p.requestCount === 1 ? 'call' : 'calls'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

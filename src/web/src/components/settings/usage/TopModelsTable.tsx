import type { UsagePerModel } from '../../../lib/api';
import { formatUsd } from '../format';

export function TopModelsTable({ perModel }: { perModel: UsagePerModel[] }) {
  if (perModel.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/40 p-4 text-xs text-muted-foreground">
        No model data yet.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-background/40">
      <div className="border-b border-border px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground">
        By model
      </div>
      <div className="divide-y divide-border/60">
        {perModel.map((m, i) => (
          <div
            key={`${m.model}-${m.provider ?? ''}-${i}`}
            className="grid grid-cols-12 items-baseline gap-2 px-4 py-2 text-xs"
          >
            <div className="col-span-7 min-w-0">
              <div className="truncate font-medium text-foreground" title={m.model}>
                {m.model}
              </div>
              {m.provider && (
                <div className="text-[10px] text-muted-foreground">{m.provider}</div>
              )}
            </div>
            <div className="col-span-2 tabular-nums text-foreground">
              {formatUsd(m.totalCostUsd)}
            </div>
            <div className="col-span-3 tabular-nums text-right text-muted-foreground">
              {m.requestCount} {m.requestCount === 1 ? 'call' : 'calls'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

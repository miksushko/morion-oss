import type { UsagePerKind } from '../../../lib/api';
import { formatUsd } from '../format';
import { KIND_META } from './usage-meta';
import { derivePerKindStats } from './usage-derive';

export function PerKindTable({ perKind }: { perKind: UsagePerKind[] }) {
  if (perKind.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-background/40 p-4 text-xs text-muted-foreground">
        No LLM calls recorded for this period yet. Start a Mo chat or run
        auto-code on a ticket to see the breakdown here.
      </div>
    );
  }
  // Sort by spend desc so optimisation candidates surface at the top.
  // Stable sort within tie via kind enum order (rare in practice).
  const sorted = [...perKind].sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  return (
    <div className="rounded-md border border-border bg-background/40">
      <div className="border-b border-border px-4 py-2 text-xs uppercase tracking-wide text-muted-foreground">
        By feature
      </div>
      <div
        className="grid grid-cols-12 gap-2 border-b border-border/60 px-4 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground"
        aria-hidden
      >
        <div className="col-span-5">Feature</div>
        <div className="col-span-2">Spend</div>
        <div className="col-span-1">Calls</div>
        <div className="col-span-2">Avg tokens (in → out)</div>
        <div className="col-span-1" title="Cache hit %">
          Cache
        </div>
        <div className="col-span-1" title="Avg hidden reasoning tokens per call">
          Reason
        </div>
      </div>
      <div className="divide-y divide-border/60">
        {sorted.map((k) => (
          <PerKindRow key={k.kind} row={k} />
        ))}
      </div>
    </div>
  );
}

function PerKindRow({ row }: { row: UsagePerKind }) {
  const meta = KIND_META[row.kind];
  const label = meta?.label ?? row.kind;
  const {
    cacheHitPct,
    avgReasoning,
    avgPromptTokens,
    avgCompletionTokens,
    fullyIncluded,
    partiallyIncluded,
  } = derivePerKindStats(row);
  const cacheCaptured = row.tokensCapturedCount.cached;

  return (
    <div className="grid grid-cols-12 items-baseline gap-2 px-4 py-2 text-xs">
      <div className="col-span-5 flex items-baseline gap-1.5 min-w-0">
        <span className="truncate font-medium text-foreground">{label}</span>
        {(fullyIncluded || partiallyIncluded) && (
          <span
            className="shrink-0 rounded-sm bg-emerald-500/15 px-1 py-0.5 text-[9px] font-medium text-emerald-700 dark:text-emerald-400"
            title={
              fullyIncluded
                ? 'Entirely covered by Claude Max subscription — equivalent API price shown for reference, not charged'
                : `${formatUsd(row.includedCostUsd)} of this spend covered by subscription`
            }
          >
            {fullyIncluded ? 'Included' : 'Mixed'}
          </span>
        )}
      </div>
      <div
        className="col-span-2 tabular-nums text-foreground"
        title={
          row.includedCostUsd > 0
            ? `Metered ${formatUsd(row.meteredCostUsd)} · Included ${formatUsd(row.includedCostUsd)}`
            : undefined
        }
      >
        {formatUsd(row.totalCostUsd)}
      </div>
      <div className="col-span-1 tabular-nums text-muted-foreground">
        {row.requestCount}
      </div>
      <div
        className="col-span-2 tabular-nums text-muted-foreground"
        title="Avg prompt / completion tokens per request"
      >
        {avgPromptTokens !== null
          ? `${avgPromptTokens.toLocaleString()} → ${avgCompletionTokens?.toLocaleString() ?? '?'}`
          : '—'}
      </div>
      <div
        className="col-span-1 tabular-nums text-muted-foreground"
        title={
          cacheHitPct !== null
            ? `${cacheCaptured} of ${row.requestCount} calls reported caching`
            : 'Provider did not report prompt-cache usage for this kind'
        }
      >
        {cacheHitPct !== null ? `${cacheHitPct.toFixed(0)}%` : '—'}
      </div>
      <div
        className="col-span-1 tabular-nums text-muted-foreground"
        title={
          avgReasoning !== null
            ? 'Average hidden reasoning tokens per call (o1 / o3 / gpt-5 / DeepSeek-R1)'
            : 'No reasoning tokens billed for this kind'
        }
      >
        {avgReasoning !== null ? avgReasoning.toLocaleString() : '—'}
      </div>
    </div>
  );
}

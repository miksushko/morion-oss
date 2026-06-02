import { cn } from '../../../lib/cn';
import { formatUsd } from '../format';

/**
 * Single budget cap card. The progress bar uses tonal colour to surface
 * state at a glance:
 *   - green   < 80 %  — comfortable headroom
 *   - amber   80-99 % — approaching cap
 *   - red    ≥ 100 %  — cap exhausted, withinBudget=false; Mo will
 *                       refuse new paid calls until reset
 *
 * `authSource` (auto-code only) shows whether Claude is OAuth-Max or
 * API-key auth'd — the same dollar number means different things (Max
 * subscription burns informational $; API-key spends real money).
 */
export function CapCard({
  label,
  subtitle,
  spentUsd,
  capUsd,
  withinBudget,
  resetsAt,
  authSource,
  includedUsd,
}: {
  label: string;
  subtitle?: string;
  /** Metered $ — what counts against the cap. For Auto-code under Max
   *  plan this is < `spentMonthUsd` because subscription-covered rows
   *  don't count. */
  spentUsd: number;
  capUsd: number;
  withinBudget: boolean;
  resetsAt: number;
  authSource?: 'oauth-max' | 'api-key' | null;
  /** Optional informational figure — equivalent API price of
   *  subscription-covered work. Renders as a green "$X covered by
   *  subscription" line below the cap bar. Hidden when 0 / undefined. */
  includedUsd?: number;
}) {
  const pct = capUsd > 0 ? Math.min(100, (spentUsd / capUsd) * 100) : 0;
  const exhausted = !withinBudget;
  const nearCap = !exhausted && pct >= 80;
  const barTone = exhausted
    ? 'bg-red-500'
    : nearCap
      ? 'bg-amber-500'
      : 'bg-emerald-500';
  const resetsInDays = Math.max(
    0,
    Math.ceil((resetsAt - Date.now()) / (24 * 60 * 60 * 1000)),
  );

  return (
    <div className="rounded-md border border-border bg-background/40 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-foreground">{label}</div>
          {subtitle && (
            <div className="text-[10px] text-muted-foreground">{subtitle}</div>
          )}
        </div>
        {authSource && (
          <span
            className={cn(
              'shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium',
              authSource === 'oauth-max'
                ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
                : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
            )}
            title={
              authSource === 'oauth-max'
                ? 'Claude OAuth Max — figure is informational (subscription billing)'
                : 'Claude API key — real per-call billing'
            }
          >
            {authSource === 'oauth-max' ? 'Max plan' : 'API'}
          </span>
        )}
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-lg font-semibold text-foreground">
          {formatUsd(spentUsd)}
        </span>
        <span className="text-xs text-muted-foreground">/ {formatUsd(capUsd)}</span>
      </div>

      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn('h-full rounded-full transition-all', barTone)}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{Math.round(pct)}% used</span>
        <span>
          {exhausted
            ? 'Cap exhausted — paid calls refused until reset'
            : `Resets in ${resetsInDays} ${resetsInDays === 1 ? 'day' : 'days'}`}
        </span>
      </div>

      {typeof includedUsd === 'number' && includedUsd > 0 && (
        <div className="mt-2 flex items-baseline justify-between border-t border-border/60 pt-2">
          <span className="text-[10px] text-muted-foreground">
            + {formatUsd(includedUsd)} covered by subscription
          </span>
          <span className="text-[10px] text-emerald-600 dark:text-emerald-500">
            Not charged
          </span>
        </div>
      )}
    </div>
  );
}

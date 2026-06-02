import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type UsageResponse } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatUsd } from './format';
import { capPercent, validateCapDraft } from './cap-validate';

/**
 * Limits tab (ticket 01KRNCDK0Y16R8QS8YP2AGSPTF). Two number inputs
 * drive the Mo + Auto-code monthly caps via debounced autosave — same
 * pattern as the per-pipeline model overrides in Mo Agent.
 *
 * Live preview reads the cap status alongside the input so a user
 * adjusting the value sees the new percentage immediately. `$0` inputs
 * surface a kill-switch warning ("freezes all paid calls"). Inputs
 * share a single `useUsageSnapshot()` style hook backed by
 * `GET /api/usage?period=current_month` — gives us cap ceilings,
 * current caps, spend, and the metered/included split in one fetch.
 */

const LIMITS_DEBOUNCE_MS = 500;

export function LimitsTab() {
  const [snap, setSnap] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .getUsage('current_month')
      .then((d) => {
        setSnap(d);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold text-foreground">Limits</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Monthly spend caps for Mo orchestration and the auto-code
          workflow. Each cap resets at the start of the next UTC calendar
          month. Values are workspace-wide.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          Failed to load limits: {error}
        </div>
      )}

      {loading && !snap ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : snap ? (
        <>
          <CapEditor
            label="Mo monthly cap"
            hint="Caps interactive chat + indexing + topic cleanup + deep-research gather. When exceeded, Mo refuses paid calls until the next UTC month."
            currentCap={snap.moCap.monthlyCapUsd}
            spentUsd={snap.moCap.spentMonthUsd}
            maxCap={snap.moCapMaxUsd}
            killSwitchCopy="Cap = $0 freezes every paid Mo call until you raise it. Background indexing keeps writing $0 ledger rows; nothing is charged."
            onSave={async (v) => {
              await api.putConciergeBudget(v);
              reload();
            }}
          />
          <CapEditor
            label="Auto-code monthly cap"
            hint="Caps fix + review + merge-resolve. Under Claude OAuth Max only metered (real $) calls count — subscription-covered work doesn't slide the cap."
            currentCap={snap.autoCodeCap.monthlyCapUsd}
            spentUsd={snap.autoCodeCap.meteredSpentMonthUsd}
            includedUsd={snap.autoCodeCap.includedSpentMonthUsd}
            maxCap={snap.autoCodeCapMaxUsd}
            authPill={snap.autoCodeCap.authSource}
            killSwitchCopy="Cap = $0 stops new auto-code claims (in-flight runs finish). The Max-plan badge above doesn't change this — even a Max user can pause auto-code by setting $0."
            onSave={async (v) => {
              await api.putAutoCodeBudget(v);
              reload();
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function CapEditor({
  label,
  hint,
  currentCap,
  spentUsd,
  includedUsd,
  maxCap,
  authPill,
  killSwitchCopy,
  onSave,
}: {
  label: string;
  hint: string;
  currentCap: number;
  spentUsd: number;
  /** Subscription-covered amount — surfaced as informational copy
   *  under the cap input. Auto-code editor only. */
  includedUsd?: number;
  maxCap: number;
  authPill?: 'oauth-max' | 'api-key' | null;
  killSwitchCopy: string;
  onSave: (value: number) => Promise<void>;
}) {
  // Local draft so the user can type freely; server-side cap is updated
  // on a debounced timer. `currentCap` (server value) seeds the draft on
  // mount and after each successful save.
  const [draft, setDraft] = useState<string>(currentCap.toFixed(0));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const lastSavedRef = useRef<number>(currentCap);

  // Sync draft when server value changes (e.g. after reload). Guarded
  // so an in-flight user edit doesn't get clobbered by a stale parent
  // value — only sync when the saved-server-value actually moved.
  useEffect(() => {
    if (currentCap !== lastSavedRef.current) {
      setDraft(currentCap.toFixed(0));
      lastSavedRef.current = currentCap;
    }
  }, [currentCap]);

  // Debounced autosave.
  useEffect(() => {
    const v = validateCapDraft(draft, maxCap);
    if (v.outOfRange) return;
    if (v.parsed === lastSavedRef.current) return;
    const handle = window.setTimeout(async () => {
      try {
        setSaving(true);
        setSaveError(null);
        await onSave(v.parsed);
        lastSavedRef.current = v.parsed;
      } catch (err: unknown) {
        setSaveError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    }, LIMITS_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [draft, maxCap, onSave]);

  const { parsed, outOfRange, isKillSwitch } = validateCapDraft(draft, maxCap);
  const pct = parsed > 0 ? capPercent(spentUsd, parsed) : 0;

  return (
    <div className="rounded-md border border-border bg-background/40 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
        {authPill && (
          <span
            className={cn(
              'shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium',
              authPill === 'oauth-max'
                ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
                : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
            )}
          >
            {authPill === 'oauth-max' ? 'Max plan' : 'API'}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-sm text-muted-foreground">$</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          max={maxCap}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className={cn(
            'w-28 rounded-md border bg-background px-2 py-1 text-sm text-foreground',
            outOfRange ? 'border-destructive/60' : 'border-border',
          )}
        />
        <span className="text-xs text-muted-foreground">/ month</span>
        {saving && (
          <span className="text-[10px] text-muted-foreground">Saving…</span>
        )}
        {!saving && !saveError && !outOfRange && parsed === lastSavedRef.current && (
          <span className="text-[10px] text-emerald-600 dark:text-emerald-500">
            Saved
          </span>
        )}
      </div>

      {outOfRange && (
        <div className="mt-1.5 text-[10px] text-destructive">
          Value must be between $0 and ${maxCap}.
        </div>
      )}
      {saveError && (
        <div className="mt-1.5 text-[10px] text-destructive">{saveError}</div>
      )}

      {isKillSwitch && (
        <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
          ⚠️ {killSwitchCopy}
        </div>
      )}

      {/* Current usage preview — re-renders after each successful save. */}
      <div className="mt-3 flex items-baseline justify-between text-[11px] text-muted-foreground">
        <span>
          Currently used:{' '}
          <span className="text-foreground">{formatUsd(spentUsd)}</span> of{' '}
          {formatUsd(currentCap)}
        </span>
        <span>{currentCap > 0 ? `${Math.round(pct)}%` : '—'}</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {typeof includedUsd === 'number' && includedUsd > 0 && (
        <div className="mt-1.5 text-[10px] text-emerald-600 dark:text-emerald-500">
          + {formatUsd(includedUsd)} covered by subscription (not counted toward cap)
        </div>
      )}
    </div>
  );
}

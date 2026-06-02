import type {
  AutoCodeBudgetStatus,
  ConciergeBudgetStatus,
} from './types.js';
import {
  MoSpendLedgerRepository,
  startOfNextUtcMonth,
  type RecordSpendInput,
} from './mo-spend-ledger.js';

/** Default monthly cap, in USD. $10 / user per the design call —
 * cheap-tier Gemini Flash Lite + Qwen Plus economics put a heavy
 * dogfood user around $4-7, leaving headroom. Tune per workspace
 * once dogfood data accumulates. */
export const MONTHLY_CAP_USD = 10;

/** Default monthly cap for auto-code spawns, in USD. $50 / workspace
 * is the design call (sub-ticket 01KQEEE1VSGFMH8T5AEXQENJVW) — a heavy
 * dogfood user lands around $20-30/mo so $50 leaves headroom while
 * still being a reasonable circuit-breaker against runaway loops.
 * Tunable via workspace setting `auto_code.monthly_budget_usd`. */
export const AUTO_CODE_MONTHLY_CAP_USD = 50;

/**
 * Budget enforcement for Mo's billed LLM spend. Reads from
 * `mo_spend_ledger` — the single append-only source of truth across
 * chat / tick / brief / `mo_tool` paths. Replaces the previous
 * `concierge_messages.cost_usd` aggregation that silently missed
 * headless tick + brief digest spend (`01KQ1H556RFFKD7WGZE77MEVFQ`).
 *
 * Soft enforcement: the engine checks `status().withinBudget` BEFORE
 * each tick. If false, the tick flips to dry-run — Mo still describes
 * what it would do, but no action runs. The cost of that final dry-run
 * call is itself billed. Subsequent ticks see the new total and stay
 * dry-run until the start of the next UTC month.
 *
 * Hard enforcement (Phase 2b+ writes through `requireWithinBudget`):
 * Mo write tools that go through the LLM tier check the budget BEFORE
 * the provider call and refuse with `mo_budget_exceeded` when over.
 * Different from the engine's soft path because user-initiated writes
 * SHOULD fail loudly — silent dry-run on `mo_report_result` would
 * leave a finished task uncomitted.
 */
/**
 * Workspace-wide Mo monthly cap, in USD. Pulled from the
 * `concierge.budget_monthly_cap_usd` setting; falls back to the
 * design default when unset OR malformed. Mirror of
 * `readAutoCodeMonthlyCap` in auto-code-factory — same shape so the
 * Limits settings tab (ticket 01KRNCDK0Y16R8QS8YP2AGSPTF) can drive
 * both caps through a uniform PUT handler.
 */
export const MO_BUDGET_SETTING_KEY = 'concierge.budget_monthly_cap_usd';

export function readMoMonthlyCap(settings: {
  get: <T>(key: string, fallback: T) => T;
}): number {
  const raw = settings.get<unknown>(MO_BUDGET_SETTING_KEY, undefined);
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return MONTHLY_CAP_USD;
}

export class BudgetTracker {
  /**
   * `monthlyCapUsd` accepts either a literal number (test convenience,
   * legacy callers) OR a getter callback so `status()` reads the cap
   * fresh on every call. Production wiring (runtime.ts) passes a
   * `() => readMoMonthlyCap(settings)` so a Limits-tab PUT to the
   * setting takes effect on the next status query without rebuilding
   * the tracker.
   */
  constructor(
    private readonly ledger: MoSpendLedgerRepository,
    private readonly monthlyCapUsd: number | (() => number) = MONTHLY_CAP_USD,
  ) {}

  private resolveCap(): number {
    return typeof this.monthlyCapUsd === 'function'
      ? this.monthlyCapUsd()
      : this.monthlyCapUsd;
  }

  status(now: number = Date.now()): ConciergeBudgetStatus {
    const breakdown = this.ledger.monthlyBreakdown(now);
    // Mo orchestration cap is on every non-auto-code kind. Slice 2
    // of ticket 01KRJSTN74FT7VRX6KAA42GGBS extends this from the four
    // legacy buckets (chat/tick/brief/mo_tool) to also include the
    // five narrow kinds (mo_indexing_tier1/tier2/catalog,
    // mo_topic_hygiene, mo_gather). Without this, the indexing tiers
    // would silently bypass the $10/mo cap after the kind swap.
    // Auto-code kinds live in the same ledger but have their own cap
    // + status object via `autoCodeStatus()`.
    const spentMonthUsd =
      breakdown.chat +
      breakdown.tick +
      breakdown.brief +
      breakdown.mo_tool +
      breakdown.mo_indexing_tier1 +
      breakdown.mo_indexing_tier2 +
      breakdown.mo_indexing_catalog +
      breakdown.mo_topic_hygiene +
      breakdown.mo_gather;
    return {
      spentMonthUsd,
      spentMonthBreakdown: {
        chat: breakdown.chat,
        tick: breakdown.tick,
        brief: breakdown.brief,
        mo_tool: breakdown.mo_tool,
        mo_indexing_tier1: breakdown.mo_indexing_tier1,
        mo_indexing_tier2: breakdown.mo_indexing_tier2,
        mo_indexing_catalog: breakdown.mo_indexing_catalog,
        mo_topic_hygiene: breakdown.mo_topic_hygiene,
        mo_gather: breakdown.mo_gather,
      },
      monthlyCapUsd: this.resolveCap(),
      withinBudget: spentMonthUsd < this.resolveCap(),
      resetsAt: startOfNextUtcMonth(now),
      spentTodayUsd: this.ledger.dailyTotalUsd(now),
    };
  }

  /**
   * Auto-code budget snapshot — separate envelope from `status()`
   * because the cap is workspace-wide ($50 default) and tracked
   * over a different `kind` subset (`auto-code-fix` /
   * `auto-code-review`). The orchestrator's `claimNext` consults
   * this BEFORE picking up a pending row; on `withinBudget=false`
   * it refuses new claims, marks pending rows with
   * `last_error='auto_code_budget_exhausted'`, and lets in-flight
   * runs finish (the cap is on NEW work, not running work).
   *
   * `cap` and `authSource` come from the caller — the BudgetTracker
   * doesn't know the workspace settings or preflight result. This
   * keeps the tracker DB-only + the route layer responsible for
   * settings reads, mirroring how the Mo cap is wired.
   */
  autoCodeStatus(
    cap: number,
    authSource: AutoCodeBudgetStatus['authSource'] = null,
    now: number = Date.now(),
  ): AutoCodeBudgetStatus {
    const breakdown = this.ledger.monthlyBreakdown(now);
    const fix = breakdown['auto-code-fix'];
    const review = breakdown['auto-code-review'];
    const mergeResolve = breakdown['auto-code-merge-resolve'];
    const spentMonthUsd = fix + review + mergeResolve;
    // Slice 12 of ticket 01KRJSTN74FT7VRX6KAA42GGBS — split into
    // metered (real $) and included (subscription-covered). The cap
    // progresses against metered only: under Claude OAuth Max a user
    // can run unlimited fixes without sliding the cap because the
    // dollar value is informational (equivalent API price, not real
    // spend). `withinBudget` flips off only when metered exceeds cap.
    const split = this.ledger.monthlyAutoCodeSplit(now);
    return {
      spentMonthUsd,
      meteredSpentMonthUsd: split.metered,
      includedSpentMonthUsd: split.included,
      spentMonthBreakdown: {
        'auto-code-fix': fix,
        'auto-code-review': review,
        'auto-code-merge-resolve': mergeResolve,
      },
      monthlyCapUsd: cap,
      withinBudget: split.metered < cap,
      resetsAt: startOfNextUtcMonth(now),
      authSource,
    };
  }

  /**
   * Append a spend row. Pure delegation to the ledger — exposed here
   * so callers that already hold a `BudgetTracker` don't need a second
   * dep just to record. Skip the row when `costUsd <= 0` (no-charge
   * call, dry-run preview, free-tier provider) so we don't bloat the
   * ledger with rows that contribute zero to the cap.
   */
  record(input: RecordSpendInput, now: number = Date.now()): void {
    if (input.costUsd <= 0) return;
    this.ledger.record(input, now);
  }
}

/**
 * Reserved for hard-cap enforcement on user-initiated Mo work.
 * Smart Mo tools (`mo_ask`, `mo_get_context`, `mo_record`, …) throw
 * this BEFORE calling the provider when `status().withinBudget ===
 * false`, so the user sees a clear refusal instead of a partial /
 * dry-run result they'd then have to clean up.
 *
 * Engine ticks intentionally do NOT throw — soft dry-run is the
 * better UX for autonomous work (see BudgetTracker comment).
 */
export class BudgetExceededError extends Error {
  readonly status: ConciergeBudgetStatus;
  constructor(status: ConciergeBudgetStatus) {
    super(
      `Mo monthly budget exhausted: $${status.spentMonthUsd.toFixed(2)} / $${status.monthlyCapUsd}. Resets at ${new Date(status.resetsAt).toISOString()}.`,
    );
    this.name = 'BudgetExceededError';
    this.status = status;
  }
}

/** Convenience denial envelope for `mo_*` tools that hit the cap.
 * Same shape as the other `mo_access_denied`-style envelopes so the
 * agent can branch on `error` + `reason` without parsing prose. */
export function moBudgetExceededDenial(status: ConciergeBudgetStatus): {
  error: 'mo_budget_exceeded';
  reason: 'monthly_cap_reached';
  message: string;
  spentMonthUsd: number;
  monthlyCapUsd: number;
  resetsAt: number;
} {
  return {
    error: 'mo_budget_exceeded',
    reason: 'monthly_cap_reached',
    message: `Mo's monthly budget for this workspace is exhausted ($${status.spentMonthUsd.toFixed(2)} / $${status.monthlyCapUsd}). Resets at the start of the next UTC month. Use raw notes_*/tasks_* tools until then, or raise the cap in Morion settings.`,
    spentMonthUsd: status.spentMonthUsd,
    monthlyCapUsd: status.monthlyCapUsd,
    resetsAt: status.resetsAt,
  };
}

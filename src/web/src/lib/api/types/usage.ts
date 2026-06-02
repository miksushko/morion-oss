/**
 * Usage stats domain types — workspace LLM spend aggregations for the
 * Settings → Usage tab. Imports cap-status fields from concierge +
 * autocode for the response envelope.
 */

import type { ConciergeBudgetStatus } from './concierge';
import type { AutoCodeBudgetStatus } from './autocode';

export type UsagePeriod =
  | 'current_month'
  | 'last_month'
  | 'last_7d'
  | 'last_30d'
  | 'all_time';

/** Mirror of `MoSpendKind` from src/core/concierge/mo-spend-ledger.ts.
 *  Legacy `tick` / `brief` rows live in historical data only — new
 *  callsites write the narrow kinds. */
export type UsageKind =
  | 'chat'
  | 'tick'
  | 'brief'
  | 'mo_tool'
  | 'auto-code-fix'
  | 'auto-code-review'
  | 'auto-code-merge-resolve'
  | 'mo_indexing_tier1'
  | 'mo_indexing_tier2'
  | 'mo_indexing_catalog'
  | 'mo_topic_hygiene'
  | 'mo_gather';

export interface UsagePerKind {
  kind: UsageKind;
  totalCostUsd: number;
  /** Slice 12 of ticket 01KRJSTN74FT7VRX6KAA42GGBS — metered = real
   *  $, included = subscription-covered (Claude OAuth Max). */
  meteredCostUsd: number;
  includedCostUsd: number;
  requestCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  /** Denominator for "%": how many rows actually captured each token
   *  column. UI renders "cache hit %" only when `cached >= 1` and
   *  shrinks `cached` to `prompt` ratio. */
  tokensCapturedCount: {
    prompt: number;
    cached: number;
    reasoning: number;
  };
}

export interface UsagePerProvider {
  provider: string | null;
  totalCostUsd: number;
  requestCount: number;
}

export interface UsagePerModel {
  model: string;
  provider: string | null;
  totalCostUsd: number;
  requestCount: number;
}

export interface UsageDaily {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  totalCostUsd: number;
  requestCount: number;
}

export interface UsageResponse {
  period: UsagePeriod;
  /** Inclusive lower bound, ms epoch. */
  from: number;
  /** Exclusive upper bound, ms epoch. */
  to: number;
  totalCostUsd: number;
  /** Slice 12 of ticket 01KRJSTN74FT7VRX6KAA42GGBS — metered vs
   *  included split across the whole window. */
  meteredCostUsd: number;
  includedCostUsd: number;
  requestCount: number;
  perKind: UsagePerKind[];
  perProvider: UsagePerProvider[];
  perModel: UsagePerModel[];
  daily: UsageDaily[];
  /** Mo monthly $10 cap status (always current month, regardless of
   *  selected period — the cap is on the billing window, not the
   *  breakdown window). */
  moCap: ConciergeBudgetStatus;
  /** Auto-code $50 cap status — same caveat. */
  autoCodeCap: AutoCodeBudgetStatus;
  /** Convenience: max-cap the PUT route would have allowed (10× the
   *  default). UI uses this for the "set cap" affordance bounds. */
  autoCodeCapMaxUsd: number;
  /** Same ceiling for the Mo cap (10× MONTHLY_CAP_USD = $100). Used
   *  by the Limits-tab Mo input's `max` attribute. Ticket
   *  01KRNCDK0Y16R8QS8YP2AGSPTF. */
  moCapMaxUsd: number;
  /** ms timestamp of the next UTC month start. */
  nextMonthResetAt: number;
}

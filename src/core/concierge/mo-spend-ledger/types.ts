/**
 * Types + DB-row shape + Usage aggregate shapes for the Mo spend
 * ledger. Extracted from `../mo-spend-ledger.ts` so the repository
 * stays focused on SQL.
 */

export type MoSpendKind =
  | 'chat'
  | 'tick'
  | 'brief'
  | 'mo_tool'
  | 'auto-code-fix'
  | 'auto-code-review'
  | 'auto-code-merge-resolve'
  // Narrow Mo kinds (migration 0037, ticket 01KRJSTN74FT7VRX6KAA42GGBS
  // slice 2). Legacy `mo_tool` rows pre-split stay valid; new tier /
  // gather callsites write the narrow kind so the Usage dashboard can
  // break "background indexing" out from "interactive Mo work".
  | 'mo_indexing_tier1'
  | 'mo_indexing_tier2'
  | 'mo_indexing_catalog'
  | 'mo_topic_hygiene'
  | 'mo_gather';

/** Subset of MoSpendKind that comes from the auto-code loop, not Mo
 *  orchestration. Cap is enforced separately (workspace setting
 *  `auto_code.monthly_budget_usd`, default $50) so a heavy auto-code
 *  user doesn't starve Mo's $10 chat budget and vice versa. */
export const AUTO_CODE_KINDS = [
  'auto-code-fix',
  'auto-code-review',
  'auto-code-merge-resolve',
] as const;
export type AutoCodeSpendKind = (typeof AUTO_CODE_KINDS)[number];

/**
 * Billing context for a single ledger row. Slice 11 of ticket
 * 01KRJSTN74FT7VRX6KAA42GGBS — separates equivalent-API-price rows
 * (Claude OAuth Max sessions burning subscription quota) from real-
 * dollar rows so the Usage dashboard can mirror the GitHub Actions /
 * Anthropic console "metered vs included" pattern.
 *
 *  - `'subscription'` — dollar amount is informational; nothing
 *    actually left the user's account. Stamped at write time when
 *    `detectClaudeAuthSource() === 'oauth-max'` (auto-code paths
 *    today; future Claude API-via-Mo paths will adopt the same hint).
 *  - `'api'` — explicit real-API-key spend. Currently unused at
 *    write time; reserved for future explicit stamping.
 *  - `null` — auth mode not captured (Mo provider rows, pre-Slice-11
 *    legacy rows). Treated as "metered" by the real-spend cap
 *    summation, same as `'api'`.
 */
export type MoSpendAuthMode = 'subscription' | 'api';

export interface MoSpendRow {
  id: string;
  kind: MoSpendKind;
  folderId: string | null;
  costUsd: number;
  createdAt: number;
  /** Backend identity (`openrouter` / `openai` / `anthropic` / `groq` /
   *  `ollama`). Null on rows written before migration 0036. */
  provider: string | null;
  /** Resolved model id echoed by the provider (NOT the requested
   *  model — providers substitute on fallback). Null pre-0036. */
  model: string | null;
  /** Input tokens billed. Null pre-0036 or when provider didn't surface. */
  promptTokens: number | null;
  /** Output tokens billed. Null pre-0036 or when provider didn't surface. */
  completionTokens: number | null;
  /** Subset of promptTokens that hit the provider's prompt cache.
   *  Drives the "cache hit ratio" metric. */
  cachedTokens: number | null;
  /** Cost of writing to the prompt cache (separate Anthropic line). */
  cacheWriteTokens: number | null;
  /** Hidden reasoning tokens billed for o1/o3/gpt-5/DeepSeek-R1. */
  reasoningTokens: number | null;
  /** Billing context — see `MoSpendAuthMode`. Null when not
   *  captured (legacy rows, Mo provider rows that don't stamp). */
  authMode: MoSpendAuthMode | null;
}

export interface RecordSpendInput {
  kind: MoSpendKind;
  folderId?: string | null;
  costUsd: number;
  /** All token / provider / model fields are optional so existing
   *  callsites compile unchanged. Slice 4 of the Usage epic plumbs
   *  them through; until then they stay null in the DB and the UI
   *  surfaces "—" rather than a misleading "0". */
  provider?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  /** Billing context (slice 11). `'subscription'` marks the row as
   *  equivalent-API-price-only (no real charge); `'api'` is explicit
   *  real spend; omitted/null = "not captured", treated as metered. */
  authMode?: MoSpendAuthMode | null;
}

export interface DbRow {
  id: string;
  kind: MoSpendKind;
  folder_id: string | null;
  cost_usd: number;
  created_at: number;
  provider: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  auth_mode: MoSpendAuthMode | null;
}

// ─── Aggregator shapes (Slice 5 of ticket 01KRJSTN74FT7VRX6KAA42GGBS) ───

export interface UsageAggregatePerKind {
  kind: MoSpendKind;
  totalCostUsd: number;
  /** `totalCostUsd` minus subscription-covered rows — what actually
   *  leaves the user's account. Slice 12. */
  meteredCostUsd: number;
  /** Subscription-covered equivalent API price (Claude OAuth Max). */
  includedCostUsd: number;
  requestCount: number;
  /** Sum of `prompt_tokens` over rows where the column was captured.
   *  Pre-Slice-4 rows contribute NULL → 0 to the sum but ARE counted
   *  in `requestCount`, so divide carefully — see
   *  `tokensCapturedCount.prompt` for the honest denominator. */
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  /** How many rows in this kind actually reported each token column.
   *  UI uses this to gate "cache hit %" / "avg reasoning tokens" —
   *  when `cached < requestCount`, show "N/A — only X/Y calls
   *  reported caching" instead of an under-counted ratio. */
  tokensCapturedCount: {
    prompt: number;
    cached: number;
    reasoning: number;
  };
}

export interface UsageAggregatePerProvider {
  /** Null when pre-Slice-1 rows (no `provider` column populated). */
  provider: string | null;
  totalCostUsd: number;
  requestCount: number;
}

export interface UsageAggregatePerModel {
  /** `(unknown)` placeholder for pre-Slice-1 rows. SQL filters
   *  NULL out at the GROUP BY level anyway; this string is the
   *  unreachable fallback for type narrowness. */
  model: string;
  provider: string | null;
  totalCostUsd: number;
  requestCount: number;
}

export interface UsageAggregateDaily {
  /** `YYYY-MM-DD` (UTC). */
  date: string;
  totalCostUsd: number;
  requestCount: number;
}

export interface UsageAggregate {
  /** Inclusive lower bound, ms epoch. */
  from: number;
  /** Exclusive upper bound, ms epoch. */
  to: number;
  totalCostUsd: number;
  /** Subset of `totalCostUsd` that's metered (real $ — `auth_mode IS
   *  NULL` or `'api'`). The Auto-code cap progresses against this
   *  number; the headline "Total spend" card surfaces both. */
  meteredCostUsd: number;
  /** Subset covered by subscription (`auth_mode = 'subscription'`).
   *  Equivalent API price; nothing actually charged. */
  includedCostUsd: number;
  requestCount: number;
  perKind: UsageAggregatePerKind[];
  perProvider: UsageAggregatePerProvider[];
  perModel: UsageAggregatePerModel[];
  daily: UsageAggregateDaily[];
}

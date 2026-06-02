/**
 * Settings → Usage tab aggregation query — the heavy multi-GROUP-BY
 * SQL block. Extracted from `../mo-spend-ledger.ts` so the repository
 * shell stays small. Stateless function — takes a Database, returns
 * a fully-shaped `UsageAggregate`.
 */

import type Database from 'better-sqlite3';
import type { MoSpendKind, UsageAggregate } from './types.js';

/**
 * Aggregate spend over an arbitrary window. Powers Settings →
 * Usage tab — per-kind / per-provider / per-model / per-day +
 * grand totals (slice 5 of ticket 01KRJSTN74FT7VRX6KAA42GGBS).
 *
 * `from` is inclusive, `to` is exclusive (standard half-open
 * range). Token sums treat NULL columns as "not captured" by
 * using `COALESCE(SUM(...), 0)` — so a row from a pre-0036 era
 * doesn't poison cache-hit % with a fake zero. The
 * `tokensCapturedCount` field surfaces how many rows actually
 * supplied each token column so the UI can show "cache hit % is
 * N/A — only 3/40 calls reported cached_tokens" instead of a
 * misleading bar.
 *
 * Daily timeseries: bucketed by UTC midnight using SQLite's
 * `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')`. Sparse
 * — only days with at least one row appear. UI joins against
 * the requested period to render zero-rows for empty days.
 */
export function aggregateByPeriod(
  db: Database.Database,
  from: number,
  to: number,
): UsageAggregate {
  const params: [number, number] = [from, to];
  // Slice 12 of ticket 01KRJSTN74FT7VRX6KAA42GGBS: every aggregation
  // level surfaces total / metered / included so the UI can render
  // GitHub Actions / Anthropic-console-style "metered vs included"
  // breakdown. `metered = cost_usd WHERE auth_mode IS NULL OR
  // 'api'`; `included = cost_usd WHERE auth_mode = 'subscription'`.
  // Sum: `metered + included === total` (no row escapes the split).
  const total = db
    .prepare<
      typeof params,
      { total: number; metered: number; included: number; requests: number }
    >(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total,
              COALESCE(SUM(CASE WHEN auth_mode = 'subscription' THEN 0 ELSE cost_usd END), 0) AS metered,
              COALESCE(SUM(CASE WHEN auth_mode = 'subscription' THEN cost_usd ELSE 0 END), 0) AS included,
              COUNT(*) AS requests
         FROM mo_spend_ledger
        WHERE created_at >= ? AND created_at < ?`,
    )
    .get(...params) ?? { total: 0, metered: 0, included: 0, requests: 0 };

  const perKindRows = db
    .prepare<
      typeof params,
      {
        kind: MoSpendKind;
        total: number;
        metered: number;
        included: number;
        requests: number;
        prompt: number | null;
        completion: number | null;
        cached: number | null;
        cache_write: number | null;
        reasoning: number | null;
        prompt_captured: number;
        cached_captured: number;
        reasoning_captured: number;
      }
    >(
      `SELECT kind,
              COALESCE(SUM(cost_usd), 0)         AS total,
              COALESCE(SUM(CASE WHEN auth_mode = 'subscription' THEN 0 ELSE cost_usd END), 0) AS metered,
              COALESCE(SUM(CASE WHEN auth_mode = 'subscription' THEN cost_usd ELSE 0 END), 0) AS included,
              COUNT(*)                            AS requests,
              SUM(prompt_tokens)                  AS prompt,
              SUM(completion_tokens)              AS completion,
              SUM(cached_tokens)                  AS cached,
              SUM(cache_write_tokens)             AS cache_write,
              SUM(reasoning_tokens)               AS reasoning,
              SUM(CASE WHEN prompt_tokens IS NOT NULL THEN 1 ELSE 0 END) AS prompt_captured,
              SUM(CASE WHEN cached_tokens IS NOT NULL THEN 1 ELSE 0 END) AS cached_captured,
              SUM(CASE WHEN reasoning_tokens IS NOT NULL THEN 1 ELSE 0 END) AS reasoning_captured
         FROM mo_spend_ledger
        WHERE created_at >= ? AND created_at < ?
        GROUP BY kind`,
    )
    .all(...params);

  const perProviderRows = db
    .prepare<
      typeof params,
      { provider: string | null; total: number; requests: number }
    >(
      `SELECT provider,
              COALESCE(SUM(cost_usd), 0) AS total,
              COUNT(*)                    AS requests
         FROM mo_spend_ledger
        WHERE created_at >= ? AND created_at < ?
        GROUP BY provider
        ORDER BY total DESC`,
    )
    .all(...params);

  const perModelRows = db
    .prepare<
      typeof params,
      {
        model: string | null;
        provider: string | null;
        total: number;
        requests: number;
      }
    >(
      `SELECT model,
              provider,
              COALESCE(SUM(cost_usd), 0) AS total,
              COUNT(*)                    AS requests
         FROM mo_spend_ledger
        WHERE created_at >= ? AND created_at < ?
          AND model IS NOT NULL
        GROUP BY model, provider
        ORDER BY total DESC`,
    )
    .all(...params);

  const dailyRows = db
    .prepare<
      typeof params,
      { day: string; total: number; requests: number }
    >(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
              COALESCE(SUM(cost_usd), 0) AS total,
              COUNT(*)                    AS requests
         FROM mo_spend_ledger
        WHERE created_at >= ? AND created_at < ?
        GROUP BY day
        ORDER BY day ASC`,
    )
    .all(...params);

  return {
    from,
    to,
    totalCostUsd: total.total,
    meteredCostUsd: total.metered,
    includedCostUsd: total.included,
    requestCount: total.requests,
    perKind: perKindRows.map((r) => ({
      kind: r.kind,
      totalCostUsd: r.total,
      meteredCostUsd: r.metered,
      includedCostUsd: r.included,
      requestCount: r.requests,
      totalPromptTokens: r.prompt ?? 0,
      totalCompletionTokens: r.completion ?? 0,
      totalCachedTokens: r.cached ?? 0,
      totalCacheWriteTokens: r.cache_write ?? 0,
      totalReasoningTokens: r.reasoning ?? 0,
      tokensCapturedCount: {
        prompt: r.prompt_captured,
        cached: r.cached_captured,
        reasoning: r.reasoning_captured,
      },
    })),
    perProvider: perProviderRows.map((r) => ({
      provider: r.provider,
      totalCostUsd: r.total,
      requestCount: r.requests,
    })),
    perModel: perModelRows.map((r) => ({
      model: r.model ?? '(unknown)',
      provider: r.provider,
      totalCostUsd: r.total,
      requestCount: r.requests,
    })),
    daily: dailyRows.map((r) => ({
      date: r.day,
      totalCostUsd: r.total,
      requestCount: r.requests,
    })),
  };
}

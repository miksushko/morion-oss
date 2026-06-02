import type { UsagePerKind } from '../../../lib/api';
import { KIND_META } from './usage-meta';

export type BucketTotals = Record<
  'interactive' | 'background' | 'auto-code',
  number
>;

/**
 * Sum `totalCostUsd` per per-kind row into the tri-split buckets used
 * by `TriSplitSummary`. Rows whose `kind` is not in `KIND_META` are
 * silently skipped (defends against a server-side enum drift where the
 * UI doesn't know about a new kind yet).
 */
export function sumPerKindByBucket(perKind: UsagePerKind[]): {
  totals: BucketTotals;
  grand: number;
} {
  const totals: BucketTotals = { interactive: 0, background: 0, 'auto-code': 0 };
  for (const k of perKind) {
    const meta = KIND_META[k.kind];
    if (meta) totals[meta.bucket] += k.totalCostUsd;
  }
  const grand = totals.interactive + totals.background + totals['auto-code'];
  return { totals, grand };
}

export interface PerKindStats {
  cacheHitPct: number | null;
  avgReasoning: number | null;
  avgPromptTokens: number | null;
  avgCompletionTokens: number | null;
  fullyIncluded: boolean;
  partiallyIncluded: boolean;
}

/**
 * Derive the per-kind row stats shown in `PerKindRow`.
 *
 *  - `cacheHitPct` is only meaningful when ≥1 row in this kind actually
 *    reported `cached_tokens`. Otherwise null → "—" (avoids misleading
 *    "0%" that is actually "no data").
 *  - `avgReasoning` only meaningful when ≥1 row reported reasoning
 *    tokens.
 *  - Avg prompt / completion tokens are normalised by `promptCaptured`
 *    (rows with full token capture). Returns null when no rows captured
 *    or when completion is missing.
 *  - `fullyIncluded` / `partiallyIncluded` drive the small green chip
 *    that flags subscription-covered rows.
 */
export function derivePerKindStats(row: UsagePerKind): PerKindStats {
  const cacheCaptured = row.tokensCapturedCount.cached;
  const promptCaptured = row.tokensCapturedCount.prompt;
  const reasoningCaptured = row.tokensCapturedCount.reasoning;

  const cacheHitPct =
    cacheCaptured > 0 && row.totalPromptTokens > 0
      ? (row.totalCachedTokens / row.totalPromptTokens) * 100
      : null;

  const avgReasoning =
    reasoningCaptured > 0
      ? Math.round(row.totalReasoningTokens / reasoningCaptured)
      : null;

  const avgPromptTokens =
    promptCaptured > 0
      ? Math.round(row.totalPromptTokens / promptCaptured)
      : null;

  const avgCompletionTokens =
    promptCaptured > 0 && row.totalCompletionTokens > 0
      ? Math.round(row.totalCompletionTokens / promptCaptured)
      : null;

  const fullyIncluded = row.includedCostUsd > 0 && row.meteredCostUsd === 0;
  const partiallyIncluded = row.includedCostUsd > 0 && row.meteredCostUsd > 0;

  return {
    cacheHitPct,
    avgReasoning,
    avgPromptTokens,
    avgCompletionTokens,
    fullyIncluded,
    partiallyIncluded,
  };
}

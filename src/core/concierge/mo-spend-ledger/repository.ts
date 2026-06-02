/**
 * `MoSpendLedgerRepository` — single SQL surface over the
 * `mo_spend_ledger` table. Extracted from `../mo-spend-ledger.ts` so
 * the public file is just a barrel.
 *
 * Append-only insert + a small set of read queries that power the
 * monthly cap (`monthlyTotalUsd` / `monthlyAutoCodeSplit`), the
 * Usage tab (`aggregateByPeriod` — delegated to the sibling
 * `aggregate-query` module), and the debug "last 50" view (`recent`).
 */

import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { aggregateByPeriod } from './aggregate-query.js';
import { rowToMoSpendRow, startOfUtcMonth } from './helpers.js';
import type {
  DbRow,
  MoSpendKind,
  MoSpendRow,
  RecordSpendInput,
  UsageAggregate,
} from './types.js';

export class MoSpendLedgerRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Append a single spend row. Cost <= 0 is rejected at the DB CHECK
   * level (defends against negative cost from a buggy provider
   * adapter). Returns the inserted row's id so callers can correlate
   * with their own logs / audit if needed.
   */
  record(input: RecordSpendInput, now: number = Date.now()): string {
    const id = ulid();
    this.db
      .prepare(
        `INSERT INTO mo_spend_ledger (
            id, kind, folder_id, cost_usd, created_at,
            provider, model,
            prompt_tokens, completion_tokens,
            cached_tokens, cache_write_tokens, reasoning_tokens,
            auth_mode
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.folderId ?? null,
        input.costUsd,
        now,
        input.provider ?? null,
        input.model ?? null,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.cachedTokens ?? null,
        input.cacheWriteTokens ?? null,
        input.reasoningTokens ?? null,
        input.authMode ?? null,
      );
    return id;
  }

  /**
   * Total spend since the start of the current UTC month. Cheap range
   * scan thanks to the `created_at` index in migration 0016.
   */
  monthlyTotalUsd(now: number = Date.now()): number {
    const since = startOfUtcMonth(now);
    const row = this.db
      .prepare<[number], { total: number }>(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
           FROM mo_spend_ledger
          WHERE created_at >= ?`,
      )
      .get(since);
    return row?.total ?? 0;
  }

  /**
   * Total spend since the start of today (UTC). Back-compat support
   * for the `spentTodayUsd` field on `ConciergeBudgetStatus` so old
   * UI surfaces don't break while the cap window moves to monthly.
   * New code should prefer `monthlyTotalUsd`.
   */
  dailyTotalUsd(now: number = Date.now()): number {
    const d = new Date(now);
    const startOfDay = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      0,
      0,
      0,
      0,
    );
    const row = this.db
      .prepare<[number], { total: number }>(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
           FROM mo_spend_ledger
          WHERE created_at >= ?`,
      )
      .get(startOfDay);
    return row?.total ?? 0;
  }

  /**
   * Per-kind breakdown for the monthly window. Useful for dogfood
   * debugging ("which path is burning the budget?") and a future UI
   * surface that shows "chat $4.20 · tick $2.10 · brief $0.80".
   */
  monthlyBreakdown(now: number = Date.now()): Record<MoSpendKind, number> {
    const since = startOfUtcMonth(now);
    const rows = this.db
      .prepare<[number], { kind: MoSpendKind; total: number }>(
        `SELECT kind, COALESCE(SUM(cost_usd), 0) AS total
           FROM mo_spend_ledger
          WHERE created_at >= ?
          GROUP BY kind`,
      )
      .all(since);
    const out: Record<MoSpendKind, number> = {
      chat: 0,
      tick: 0,
      brief: 0,
      mo_tool: 0,
      'auto-code-fix': 0,
      'auto-code-review': 0,
      'auto-code-merge-resolve': 0,
      mo_indexing_tier1: 0,
      mo_indexing_tier2: 0,
      mo_indexing_catalog: 0,
      mo_topic_hygiene: 0,
      mo_gather: 0,
    };
    for (const r of rows) out[r.kind] = r.total;
    return out;
  }

  /**
   * Split of auto-code monthly spend into "metered" (real API charges
   * — `auth_mode IS NULL OR auth_mode = 'api'`) vs "included" (covered
   * by Claude OAuth Max subscription — `auth_mode = 'subscription'`).
   * Slice 12 of ticket 01KRJSTN74FT7VRX6KAA42GGBS. The auto-code cap
   * status uses `metered` for the progress bar; `included` is
   * informational ("$X covered by subscription").
   */
  monthlyAutoCodeSplit(now: number = Date.now()): {
    metered: number;
    included: number;
  } {
    const since = startOfUtcMonth(now);
    const row = this.db
      .prepare<[number], { metered: number; included: number }>(
        `SELECT
           COALESCE(SUM(CASE WHEN auth_mode = 'subscription' THEN 0 ELSE cost_usd END), 0) AS metered,
           COALESCE(SUM(CASE WHEN auth_mode = 'subscription' THEN cost_usd ELSE 0 END), 0) AS included
         FROM mo_spend_ledger
         WHERE created_at >= ?
           AND kind LIKE 'auto-code-%'`,
      )
      .get(since);
    return { metered: row?.metered ?? 0, included: row?.included ?? 0 };
  }

  /**
   * Auto-code spend in the current UTC month. Workspace-wide (no
   * folder filter by default — the cap is workspace-wide). Optional
   * `folderId` scopes to one folder for per-folder dogfood debugging
   * but the production cap is the workspace total. Uses the
   * `(kind, created_at)` index from migration 0022 — O(log n) range
   * scan over a tiny subset, not a full-month full-table scan.
   */
  monthlyAutoCodeTotalUsd(
    now: number = Date.now(),
    folderId?: string,
  ): number {
    const since = startOfUtcMonth(now);
    if (folderId) {
      const row = this.db
        .prepare<[number, string], { total: number }>(
          `SELECT COALESCE(SUM(cost_usd), 0) AS total
             FROM mo_spend_ledger
            WHERE created_at >= ?
              AND folder_id = ?
              AND kind LIKE 'auto-code-%'`,
        )
        .get(since, folderId);
      return row?.total ?? 0;
    }
    const row = this.db
      .prepare<[number], { total: number }>(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total
           FROM mo_spend_ledger
          WHERE created_at >= ?
            AND kind LIKE 'auto-code-%'`,
      )
      .get(since);
    return row?.total ?? 0;
  }

  /**
   * Aggregate spend over an arbitrary window. Delegates to the
   * `aggregate-query` module — kept as a method for back-compat
   * with existing callsites that expect `repo.aggregateByPeriod(...)`.
   */
  aggregateByPeriod(from: number, to: number): UsageAggregate {
    return aggregateByPeriod(this.db, from, to);
  }

  /**
   * Recent rows, newest first. Capped to keep the response small —
   * intended for a "last 50 Mo charges" debug view, not bulk export.
   */
  recent(limit = 50): MoSpendRow[] {
    const rows = this.db
      .prepare<[number], DbRow>(
        `SELECT id, kind, folder_id, cost_usd, created_at,
                provider, model,
                prompt_tokens, completion_tokens,
                cached_tokens, cache_write_tokens, reasoning_tokens,
                auth_mode
           FROM mo_spend_ledger
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 500)));
    return rows.map(rowToMoSpendRow);
  }
}

/**
 * Pure helpers for the Mo spend ledger — UTC month boundaries, row
 * mapping, LLMResponse → RecordSpendInput conversion. Extracted from
 * `../mo-spend-ledger.ts` so the repository stays focused on SQL.
 */

import type { LLMResponse } from '../provider.js';
import type {
  DbRow,
  MoSpendKind,
  MoSpendRow,
  RecordSpendInput,
  MoSpendAuthMode,
} from './types.js';

/**
 * Start of the current UTC calendar month, in milliseconds. Used as
 * the lower bound for the monthly spend window — matches how most
 * cloud providers bill (calendar month, UTC) so the Mo cap aligns
 * with whatever quota the user negotiates upstream.
 */
export function startOfUtcMonth(now: number = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
}

/**
 * Start of the NEXT UTC month — the moment the monthly window resets.
 * Surface this to the UI so the user sees "resets in 3 days" instead
 * of just "spent $9.50 / $10.00".
 */
export function startOfNextUtcMonth(now: number = Date.now()): number {
  const d = new Date(now);
  const nextMonth = d.getUTCMonth() + 1;
  return Date.UTC(d.getUTCFullYear(), nextMonth, 1, 0, 0, 0, 0);
}

/**
 * Build a `RecordSpendInput` from an `LLMResponse` so callsites
 * don't repeat the same 10-field literal eight times. Slice 4 of
 * ticket 01KRJSTN74FT7VRX6KAA42GGBS uses this at every
 * `budget.record(...)` site that's downstream of a provider call.
 *
 * Future-proofing: when a provider gains a new `usage.*` field that
 * we want in the ledger, we extend this helper + the `RecordSpendInput`
 * shape — callsites stay untouched.
 */
export function spendInputFromLLMResponse(
  base: {
    kind: MoSpendKind;
    folderId?: string | null;
    /** Slice 11 — caller can stamp the billing context if it has the
     *  hint. Mo provider callsites omit this (treated as metered);
     *  future Claude-API-via-Mo could pass `'subscription'` when the
     *  user is on OAuth Max. */
    authMode?: MoSpendAuthMode | null;
  },
  response: LLMResponse,
): RecordSpendInput {
  return {
    kind: base.kind,
    folderId: base.folderId ?? null,
    costUsd: response.costUsd,
    provider: response.providerName ?? null,
    model: response.model ?? null,
    promptTokens: response.tokensIn ?? null,
    completionTokens: response.tokensOut ?? null,
    cachedTokens: response.cachedTokens ?? null,
    cacheWriteTokens: response.cacheWriteTokens ?? null,
    reasoningTokens: response.reasoningTokens ?? null,
    authMode: base.authMode ?? null,
  };
}

export function rowToMoSpendRow(r: DbRow): MoSpendRow {
  return {
    id: r.id,
    kind: r.kind,
    folderId: r.folder_id,
    costUsd: r.cost_usd,
    createdAt: r.created_at,
    provider: r.provider,
    model: r.model,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    cachedTokens: r.cached_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    reasoningTokens: r.reasoning_tokens,
    authMode: r.auth_mode,
  };
}

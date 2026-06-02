import type { LLMProvider } from './provider.js';
import { completeWithFallback } from './provider.js';
import type { BudgetTracker } from './budget.js';
import { moBudgetExceededDenial } from './budget.js';
import {
  spendInputFromLLMResponse,
  type MoSpendKind,
} from './mo-spend-ledger.js';

/**
 * Sub-Mo orchestration. Mo is an agent, not a CRUD wrapper — for a
 * non-trivial read or write request it decomposes the work into
 * focused sub-LLM calls (read this note, extract relevant chunks),
 * runs them in parallel, then synthesises.
 *
 * Sub-Mos are **pure extractors**: no MCP tools, no side effects, no
 * recursive sub-spawn. Main Mo pre-fetches whatever bodies need
 * reading via deterministic repository calls, hands `(body, focused
 * question)` pairs to sub-Mos, gets text back. Closed attack surface,
 * cheap, deterministic enough to reason about cost.
 *
 * Why we own this instead of using a framework:
 *   - Claude Agent SDK / OpenAI Swarm tie us to one provider; Mo
 *     speaks Groq + OpenRouter through a uniform `LLMProvider`.
 *   - LangChain / AutoGen pull in megabytes of dependencies to
 *     wrap Promise.all. We need 30 lines.
 *   - Budget integration is built-in here — every sub-Mo call records
 *     to the same monthly ledger as `mo_*` tools, so the $10/mo cap
 *     stays enforceable across all paths.
 */

export interface MoOrchestratorDeps {
  provider: LLMProvider;
  /** Primary model id (cheap-tier — Gemini Flash Lite class). */
  model: string;
  /** Optional fallback model passed to `completeWithFallback`. Same
   * model-rotation contract as the rest of the Concierge stack. */
  fallbackModel?: string | null;
  budget: BudgetTracker;
  /** Spend kind to record sub-Mo calls under. Default `mo_tool`
   * preserves the pre-Slice-2 behaviour (mo_record / mo_remember /
   * auto-code workflow Mo decisions). `gatherContext` overrides to
   * `mo_gather` so deep-research reads land in the Interactive
   * bucket, not the Background bucket. */
  spendKind?: MoSpendKind;
}

export interface SpawnSubMoInput {
  systemPrompt: string;
  userPrompt: string;
  /** Folder this sub-call is on behalf of, recorded in the ledger
   * so the per-folder spend breakdown stays accurate. Null for
   * unscoped (e.g. workspace-wide question). */
  folderId?: string | null;
  /** Temperature override. Defaults to 0.2 — sub-Mos extract /
   * decide, they don't generate prose. Synthesis steps in callers
   * can pass higher. */
  temperature?: number;
}

export interface SubMoResult {
  /** Raw assistant text. Caller parses (often as JSON). */
  content: string;
  costUsd: number;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

/**
 * Single sub-Mo call. Records cost to the budget ledger as
 * `kind: 'mo_tool'` so the monthly cap counts every parallel
 * extraction, not just the synthesis step.
 *
 * NOT budget-gated here — gating fires once at the orchestration
 * batch level so partial failures don't leave the caller with half a
 * pipeline. Top-level mo_* tool handlers MUST check
 * `budget.status().withinBudget` before invoking.
 */
export async function spawnSubMo(
  deps: MoOrchestratorDeps,
  input: SpawnSubMoInput,
): Promise<SubMoResult> {
  const resp = await completeWithFallback(
    deps.provider,
    {
      model: deps.model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
      temperature: input.temperature ?? 0.2,
    },
    deps.fallbackModel ?? null,
  );
  deps.budget.record(
    spendInputFromLLMResponse(
      {
        kind: deps.spendKind ?? 'mo_tool',
        folderId: input.folderId ?? null,
      },
      resp,
    ),
  );
  return {
    content: resp.content,
    costUsd: resp.costUsd,
    model: resp.model,
    tokensIn: resp.tokensIn,
    tokensOut: resp.tokensOut,
  };
}

export interface SpawnBatchOptions {
  /** Max parallel sub-Mo calls. Default 5 — high enough that fan-out
   * over typical 5-10 candidate notes finishes in one wave, low
   * enough that a runaway main call can't hammer the provider's
   * rate limit on every TPM bucket. */
  concurrency?: number;
}

/**
 * Run N sub-Mo calls with bounded concurrency. Returns results in
 * the same order as inputs (NOT completion order), so callers can
 * correlate `results[i]` with `inputs[i]`.
 *
 * Rejected sub-Mo calls bubble — we deliberately don't catch them
 * here. The caller decides whether one extractor failing should fail
 * the whole synthesis or be replaced with an empty chunk. This
 * matches how `Promise.all` works elsewhere in the codebase.
 *
 * Budget gate: caller MUST verify `budget.status().withinBudget`
 * BEFORE invoking; mid-batch overflow is acceptable (next user-
 * facing call denies cleanly). The batch itself doesn't peek at
 * budget between calls — keeps the orchestrator deterministic.
 */
export async function spawnSubMoBatch(
  deps: MoOrchestratorDeps,
  inputs: readonly SpawnSubMoInput[],
  opts: SpawnBatchOptions = {},
): Promise<SubMoResult[]> {
  if (inputs.length === 0) return [];
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 5, inputs.length));
  const results = new Array<SubMoResult>(inputs.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= inputs.length) return;
        results[idx] = await spawnSubMo(deps, inputs[idx]);
      }
    }),
  );
  return results;
}

/**
 * Up-front budget check shared by every smart `mo_*` tool. Returns
 * `null` to allow, or the standard denial envelope (caller returns
 * it directly to the agent). Centralised so every entry point
 * enforces the cap identically.
 */
export function requireBudget(budget: BudgetTracker):
  | ReturnType<typeof moBudgetExceededDenial>
  | null {
  const status = budget.status();
  if (status.withinBudget) return null;
  return moBudgetExceededDenial(status);
}

import { z } from 'zod';
import {
  spawnSubMo,
  type MoOrchestratorDeps,
  type SpawnSubMoInput,
  type SubMoResult,
} from './mo-orchestrator.js';

/**
 * Phase 4 — context restructure ticket `01KQFQ1RJV7EH0X3WF2H1A476J`.
 *
 * One canonical sub-Mo prompt template parameterised by `{role, scope,
 * output_schema}`. Replaces the would-be sprawl of 5+ ad-hoc role
 * prompts with a single shape — change `HARD_RULES` once and every
 * sub-Mo respects the new contract.
 *
 * Hard rules block (shared across every role):
 *   - Output strict JSON matching the supplied schema, no preamble.
 *   - No tool use — sub-Mos are pure extractors.
 *   - Bounded input — caller-supplied scope MUST stay under ~5k tokens.
 *   - Best-effort partial: if the requested data is missing from the
 *     scope, return an empty / null-shaped object instead of refusing.
 *
 * The runner (`runSubMoTask`) wraps `spawnSubMo` with:
 *   - JSON parse + Zod validate
 *   - Single retry on malformed JSON (with an explicit "your previous
 *     output failed JSON.parse — emit ONLY the JSON object" reminder)
 *   - `{ok: true, data}` / `{ok: false, reason, raw?}` envelope so
 *     batch callers can continue best-effort instead of throwing.
 */

const HARD_RULES = `
HARD RULES (apply to every response):
1. Respond with ONE JSON object that matches the schema below. No prose, no preamble, no explanation. Begin with \`{\` and end with \`}\`.
2. You have NO tools. Use only the data provided in the user message. Do NOT fabricate ids, dates, or facts not present in the input.
3. If the requested data is absent from the input, return the schema's empty / null shape (e.g. empty arrays, null fields). Do NOT refuse, do NOT explain — emit a valid JSON object that says "nothing here".
4. Be concise. Output stays under 1000 tokens unless the schema explicitly allows longer fields.
`.trim();

export interface SubMoRole<T> {
  /** Stable role identifier — used in logs, audit, and the prompt
   *  header so a misrouted sub-Mo is debuggable. */
  readonly name: string;
  /** One-line description of what this role's job is. Goes into the
   *  prompt header so the model has the framing before it sees the
   *  hard rules + schema. */
  readonly purpose: string;
  /** Zod schema for the parsed JSON output. Validated post-parse;
   *  validation failure triggers one retry, then `{ok: false}`. */
  readonly schema: z.ZodType<T>;
  /** Plain-text rendering of the schema for the model. Zod's runtime
   *  doesn't ship a stable JSON-schema serialiser without
   *  `zod-to-json-schema`, and we want the prompt block to be hand-
   *  curated for clarity (field descriptions matter). */
  readonly schemaDescription: string;
  /** Optional extra rules specific to this role, appended after the
   *  shared HARD_RULES block. Keep concise. */
  readonly extraRules?: string;
}

export function buildSubMoSystemPrompt<T>(role: SubMoRole<T>): string {
  const parts = [
    `You are a sub-Mo agent. Role: \`${role.name}\`.`,
    role.purpose,
    ``,
    HARD_RULES,
  ];
  if (role.extraRules && role.extraRules.trim().length > 0) {
    parts.push('', role.extraRules.trim());
  }
  parts.push('', 'OUTPUT SCHEMA:', role.schemaDescription);
  return parts.join('\n');
}

/**
 * Successful sub-Mo task — JSON parsed and Zod-validated.
 */
export interface SubMoTaskOk<T> {
  ok: true;
  data: T;
  /** Cost / model / token usage from the underlying provider call.
   *  Both retry attempts (when applicable) sum here so the budget
   *  envelope reflects real spend. */
  costUsd: number;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  /** True when the result came from the retry attempt (first call
   *  emitted unparseable JSON). Useful for telemetry — a high retry
   *  rate means the schema description / hard rules need tightening. */
  retried: boolean;
}

/**
 * Failed sub-Mo task. `raw` carries the model output when the failure
 * was downstream of provider success (parse / validate); absent when
 * the provider itself errored. Batch callers continue with the rest
 * and surface failures via the result envelope.
 */
export interface SubMoTaskErr {
  ok: false;
  reason:
    | 'invalid_json'      // JSON.parse failed on both attempts
    | 'schema_mismatch'   // parsed but Zod validation failed both attempts
    | 'provider_error';   // spawnSubMo threw
  raw?: string;
  errorMessage?: string;
  /** Total cost across both attempts; we charge for partial work even
   *  on failure so the budget tracker stays honest. */
  costUsd: number;
}

export type SubMoTaskResult<T> = SubMoTaskOk<T> | SubMoTaskErr;

const RETRY_REMINDER =
  'Your previous response could not be parsed as JSON matching the OUTPUT SCHEMA. Re-emit a single valid JSON object — nothing else, no preamble, no markdown fences. Begin with `{` and end with `}`.';

/**
 * Run one sub-Mo task end-to-end: spawn → parse → validate. On invalid
 * JSON or schema mismatch, retries ONCE with an explicit reminder.
 * Always resolves (never throws) so batch callers can rely on a
 * uniform `{ok}` envelope.
 *
 * `userScope` is the per-task input. Caller is responsible for keeping
 * it under the ~5k token cap mentioned in HARD_RULES.
 */
export async function runSubMoTask<T>(
  deps: MoOrchestratorDeps,
  role: SubMoRole<T>,
  userScope: string,
  options: { folderId?: string | null; temperature?: number } = {},
): Promise<SubMoTaskResult<T>> {
  const systemPrompt = buildSubMoSystemPrompt(role);
  let totalCost = 0;
  let lastRaw: string | undefined;
  let lastError: string | undefined;
  let lastFailureKind: 'invalid_json' | 'schema_mismatch' = 'invalid_json';

  for (let attempt = 0; attempt < 2; attempt++) {
    const userPrompt =
      attempt === 0 ? userScope : `${userScope}\n\n${RETRY_REMINDER}`;

    let result: SubMoResult;
    try {
      result = await spawnSubMo(deps, {
        systemPrompt,
        userPrompt,
        folderId: options.folderId ?? null,
        temperature: options.temperature ?? 0.2,
      });
    } catch (err) {
      // Provider-side failure — short-circuit, no retry. Caller +
      // budget tracker still see the partial cost from any prior
      // attempt (zero on attempt 0).
      return {
        ok: false,
        reason: 'provider_error',
        errorMessage: (err as Error).message,
        costUsd: totalCost,
      };
    }

    totalCost += result.costUsd;
    lastRaw = result.content;

    const parsed = tryParseJson(result.content);
    if (!parsed.ok) {
      lastFailureKind = 'invalid_json';
      lastError = parsed.error;
      continue;
    }

    const validated = role.schema.safeParse(parsed.value);
    if (!validated.success) {
      lastFailureKind = 'schema_mismatch';
      lastError = validated.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      continue;
    }

    return {
      ok: true,
      data: validated.data,
      costUsd: totalCost,
      model: result.model,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      retried: attempt > 0,
    };
  }

  return {
    ok: false,
    reason: lastFailureKind,
    raw: lastRaw,
    errorMessage: lastError,
    costUsd: totalCost,
  };
}

/**
 * Best-effort batch runner. Spawns N sub-Mo tasks with bounded
 * concurrency (default 5, mirrors `spawnSubMoBatch`). One failed task
 * does NOT abort the others — the result array preserves input order
 * with `{ok: false}` envelopes for failures, so the calling pipeline
 * can synthesise on partial findings (`Wave 1: 8/10 sub-Mos returned,
 * 2 failed schema validation`).
 *
 * This is the contract the deep-context-gather engine (`mo_get_context`)
 * relies on: a single rate-limited / malformed-JSON sub-Mo can't crash
 * the whole call.
 */
export interface SubMoBatchOptions {
  concurrency?: number;
  /** When the failure rate of a batch exceeds this fraction, the
   *  caller will likely want to abort + escalate rather than synthesise
   *  on a near-empty result set. Returned in the summary, not enforced
   *  here — synthesis decision belongs upstream. Default 0.5. */
  failureWarnAt?: number;
}

export interface SubMoBatchSummary<T> {
  results: ReadonlyArray<SubMoTaskResult<T>>;
  okCount: number;
  failedCount: number;
  totalCostUsd: number;
  /** True iff `failedCount / results.length > failureWarnAt` AND
   *  results.length > 0. Caller uses this to decide whether to
   *  surface a partial-result warning to the agent / user. */
  failureRateExceeded: boolean;
}

export async function runSubMoBatch<T>(
  deps: MoOrchestratorDeps,
  role: SubMoRole<T>,
  scopes: ReadonlyArray<{ scope: string; folderId?: string | null }>,
  opts: SubMoBatchOptions = {},
): Promise<SubMoBatchSummary<T>> {
  const concurrency = Math.max(
    1,
    Math.min(opts.concurrency ?? 5, Math.max(scopes.length, 1)),
  );
  const failureWarnAt = opts.failureWarnAt ?? 0.5;

  const results = new Array<SubMoTaskResult<T>>(scopes.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= scopes.length) return;
        const s = scopes[idx]!;
        results[idx] = await runSubMoTask(deps, role, s.scope, {
          folderId: s.folderId ?? null,
        });
      }
    }),
  );

  let okCount = 0;
  let failedCount = 0;
  let totalCostUsd = 0;
  for (const r of results) {
    if (r.ok) okCount++;
    else failedCount++;
    totalCostUsd += r.costUsd;
  }

  return {
    results,
    okCount,
    failedCount,
    totalCostUsd,
    failureRateExceeded:
      results.length > 0 && failedCount / results.length > failureWarnAt,
  };
}

interface JsonParseOk {
  ok: true;
  value: unknown;
}
interface JsonParseErr {
  ok: false;
  error: string;
}

/**
 * Tolerant JSON parser. Strips the most common malformed-output
 * shapes before giving up:
 *   - Markdown fences: ` ```json ... ``` ` / ` ``` ... ``` `
 *   - Leading/trailing prose, when a `{...}` JSON object is embedded
 *
 * Doesn't try to repair internal JSON syntax errors — at that point
 * the model didn't follow the contract and a retry with the explicit
 * reminder is the right escalation.
 */
function tryParseJson(raw: string): JsonParseOk | JsonParseErr {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: 'empty response' };

  const candidates = [trimmed, stripFence(trimmed), extractFirstObject(trimmed)];
  for (const c of candidates) {
    if (c === null) continue;
    try {
      return { ok: true, value: JSON.parse(c) };
    } catch {
      // try next candidate
    }
  }
  return { ok: false, error: 'no parseable JSON object found' };
}

function stripFence(s: string): string | null {
  const fence = /^```(?:json|JSON)?\s*\n([\s\S]*?)\n```\s*$/;
  const m = s.match(fence);
  return m ? m[1]!.trim() : null;
}

function extractFirstObject(s: string): string | null {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

// Re-export for tests + future engine code that pre-builds prompts.
export type { SpawnSubMoInput, SubMoResult };

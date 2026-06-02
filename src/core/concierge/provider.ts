/**
 * Direction V — LLM provider abstraction for the Concierge engine.
 *
 * Spec § MVP direction: "Start cloud-first via OpenRouter or direct
 * provider key behind a provider interface. Local model support can
 * come later as an optional provider if quality/performance is good
 * enough." This file is THE boundary — swapping Kimi K2.5 → K2.6 →
 * Claude → a local llama.cpp sidecar is a new provider implementation,
 * nothing else in the engine changes.
 *
 * Shape deliberately mirrors the OpenAI/Anthropic tool-calling pattern
 * (messages + tools → assistant message w/ optional tool_calls) so the
 * initial OpenRouter impl is a thin transform and the same `Message`
 * array round-trips cleanly through the database.
 */

import type { ConciergeMessageRole } from './types.js';

export interface LLMMessage {
  role: ConciergeMessageRole;
  content: string;
  /** Set on role='assistant' turns when the provider emitted tool
   * calls. OpenAI-compatible providers require the next role='tool'
   * messages to be preceded by this exact assistant/tool_calls turn. */
  toolCalls?: LLMToolCall[];
  /** Set on role='tool' replies so the assistant's prior tool_call_id
   * gets paired back on the next turn. */
  toolCallId?: string | null;
}

export interface LLMToolDefinition {
  /** Must match a `ConciergeActionKind` 1-to-1 so the engine dispatcher
   * can route tool calls directly. */
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. Providers that don't accept
   * schemas (stub/mock) can ignore this. */
  parameters: Record<string, unknown>;
}

export interface LLMToolCall {
  id: string;
  name: string;
  /** Raw JSON string of the call arguments. Engine parses + validates
   * against the tool's declared schema before dispatching. */
  argumentsJson: string;
}

export interface LLMRequest {
  model: string;
  messages: LLMMessage[];
  tools?: LLMToolDefinition[];
  /** Temperature for provider calls. Engine picks a low value (~0.2)
   * for deterministic-ish workflow decisions and bumps it for free-
   * form chat responses. */
  temperature?: number;
}

export interface LLMResponse {
  /** Final assistant text (can be empty when the model only emits
   * tool calls). */
  content: string;
  toolCalls: LLMToolCall[];
  tokensIn: number | null;
  tokensOut: number | null;
  /** Cost in USD billed for this call. Providers that don't surface
   * cost directly should compute it from token counts + their public
   * price list so the $5/day cap remains enforceable. */
  costUsd: number;
  /** Echo of the model id the response came from (provider may
   * substitute for fallbacks — we want ground truth in the ledger). */
  model: string;
  // ─── Usage stats fields (slice 3 of ticket 01KRJSTN74FT7VRX6KAA42GGBS) ──
  // All four fields are nullable when the provider doesn't surface
  // them — local models, lenient OpenAI-compat servers, free-tier
  // upstream that elides usage details. Callsites that plumb into
  // the ledger pass through `?? null`; the aggregator (Slice 5)
  // treats null as "not captured" rather than 0 so cache-hit %
  // doesn't drown in fake-zero rows.
  /** Subset of `tokensIn` that hit the provider's prompt cache
   *  (OpenRouter `usage.prompt_tokens_details.cached_tokens` /
   *  Anthropic `cache_read_input_tokens` / OpenAI
   *  `prompt_tokens_details.cached_tokens`). Drives the Usage
   *  dashboard's "cache hit %" metric per kind. */
  cachedTokens?: number | null;
  /** Cost of writing to the prompt cache (Anthropic
   *  `cache_creation_input_tokens` — billed separately from
   *  cache reads / regular prompt tokens). */
  cacheWriteTokens?: number | null;
  /** Hidden reasoning tokens billed for o1/o3/gpt-5/DeepSeek-R1.
   *  Not visible in `tokensOut` (`completion_tokens`); explains
   *  "why is this short answer so expensive". OpenRouter surfaces
   *  this as `usage.completion_tokens_details.reasoning_tokens`. */
  reasoningTokens?: number | null;
  /** Backend identity — `openrouter` / `openai` / `anthropic` /
   *  `groq` / `ollama` / `noop`. Mirrors `LLMProvider.name`. Set
   *  here so callers don't have to thread the provider name
   *  through every plumbing layer to record it in the ledger. */
  providerName?: string;
}

/**
 * Implementations MUST surface `costUsd` even on failure-retry paths —
 * the budget tracker relies on seeing spent dollars for every call the
 * provider actually made, including retries it did internally.
 */
export interface LLMProvider {
  readonly name: string;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

/**
 * Default provider stub used when no API key is configured. Returns a
 * deterministic "not configured" message so tests + fresh installs
 * don't hit the network. The engine treats this as a terminal state
 * and surfaces a UI banner pointing the user at Settings → Concierge.
 */
/**
 * Sentinel string the UI layer matches to render a "Configure Mo" CTA
 * instead of the raw paragraph. Kept as a stable string across releases
 * so older UIs that don't recognise it still show something readable.
 * Any UI update should detect this exact prefix (case-sensitive) to
 * swap in the button.
 */
export const NOOP_NOT_CONFIGURED_MARKER =
  '__MO_NOT_CONFIGURED__';

export class NoopLLMProvider implements LLMProvider {
  readonly name = 'noop';
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    // Leading sentinel + human-readable fallback so clients without
    // the CTA-detection logic still show a sensible message. The
    // natural-language part deliberately contains the phrase "not
    // configured" (tested by concierge.test.ts + concierge-http.test.ts
    // as a contract — legacy clients doing substring matching still
    // find it).
    return {
      content:
        `${NOOP_NOT_CONFIGURED_MARKER} Mo is not configured yet. Open the gear icon in the Ask Mo panel header to set up a model.`,
      toolCalls: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      model: 'noop',
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      providerName: this.name,
    };
  }
}

/**
 * Call `provider.complete(req)` with a fallback model. If the primary
 * call throws (provider outage, model-not-found, rate-limit, 5xx, etc)
 * and a `fallbackModel` is configured AND differs from the primary,
 * retry once with the fallback model id. Second failure surfaces the
 * second error — callers decide how to handle it.
 *
 * Usage pattern (Direction X CC7):
 *   - Brief digest:  primary = concierge.brief_model,
 *                    fallback = concierge.brief_model_fallback
 *   - Ask Mo chat:   primary = concierge.model,
 *                    fallback = concierge.chat_model_fallback
 *
 * Why single-retry: double-provider failures signal real infra trouble
 * (both are down, or both reject the API key). A third retry just
 * burns latency. Budget cost is billed per successful call so a failed
 * primary doesn't double-charge.
 */
export async function completeWithFallback(
  provider: LLMProvider,
  req: LLMRequest,
  fallbackModel: string | null,
): Promise<LLMResponse> {
  try {
    return await provider.complete(req);
  } catch (err) {
    const primaryMsg = describeProviderError(err).slice(0, 200);
    if (!fallbackModel || fallbackModel === req.model) {
      // Re-throw with the enriched message so callers don't have to
      // peel `err.cause` themselves — Node's undici wraps the actual
      // network failure (ENOTFOUND, ECONNREFUSED, TLS handshake) inside
      // a generic "fetch failed" Error. Without `cause`, ops debugging
      // is "what failed exactly?" forever. 2026-04-25 incident.
      throw new Error(primaryMsg, { cause: err });
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[concierge] primary model "${req.model}" failed, retrying with "${fallbackModel}": ${primaryMsg}`,
    );
    try {
      return await provider.complete({ ...req, model: fallbackModel });
    } catch (fallbackErr) {
      const fallbackMsg = describeProviderError(fallbackErr).slice(0, 200);
      throw new Error(
        `${fallbackMsg} (after primary fallback attempt with "${req.model}": ${primaryMsg})`,
        { cause: fallbackErr },
      );
    }
  }
}

/**
 * Squash a provider error into a single human-readable string,
 * surfacing `err.cause.code` / `err.cause.message` when present so a
 * generic Node `fetch failed` becomes
 *   `fetch failed (ENOTFOUND api.groq.com)` or
 *   `fetch failed (UND_ERR_CONNECT_TIMEOUT)` etc.
 *
 * Most fetch-level failures land here:
 *   - DNS not yet warm after sleep/wake (ENOTFOUND, EAI_AGAIN)
 *   - VPN re-attaching (ECONNREFUSED, EHOSTUNREACH)
 *   - TLS handshake during clock skew (CERT_HAS_EXPIRED, certificate)
 *   - Captive portal hijack (UND_ERR_SOCKET, ECONNRESET)
 *
 * Each of those is actionable for the user IF they see it. Hiding it
 * behind a generic "fetch failed" turns "wait 30s and try again" into
 * "open a support ticket." Fix is a single helper everyone routes
 * through.
 */
export function describeProviderError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const causeBits: string[] = [];
  if (cause && typeof cause === 'object') {
    const c = cause as { code?: string; message?: string; hostname?: string };
    if (typeof c.code === 'string' && c.code.length > 0) causeBits.push(c.code);
    if (typeof c.hostname === 'string' && c.hostname.length > 0) {
      causeBits.push(c.hostname);
    } else if (typeof c.message === 'string' && c.message.length > 0 && c.message !== err.message) {
      causeBits.push(c.message);
    }
  }
  if (causeBits.length === 0) return err.message;
  return `${err.message} (${causeBits.join(' ')})`;
}

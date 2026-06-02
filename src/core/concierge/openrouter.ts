import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
} from './provider.js';

/**
 * Direction V — OpenRouter provider (cloud-first MVP).
 *
 * V7 default model is `x-ai/grok-4.1-fast` (xAI), picked over Kimi
 * K2.5 after smoke-test: faster first-token, persona holds better
 * under injection attempts, same cost bracket ($0.20 / $0.50 per M).
 * The engine passes `req.model` through — this provider does NOT
 * hardcode a default. The backend router in
 * `src/server/routes/concierge.ts` supplies it.
 *
 * `pricing` is a local override map: OpenRouter returns per-call token
 * counts but doesn't always surface a precomputed `cost_usd` field for
 * free-tier models, so we compute cost from published
 * per-million-token prices ourselves. Free-tier models have
 * `input=0, output=0` entries.
 *
 * **API key is NEVER committed.** It lives in the `settings` table
 * or the `MORION_OPENROUTER_API_KEY` env var. Constructor throws if
 * neither is supplied; `NoopLLMProvider` is the fallback for the
 * "Concierge not configured" path.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';

  constructor(
    private readonly apiKey: string,
    private readonly opts: OpenRouterOptions = {},
  ) {
    if (!apiKey || !apiKey.startsWith('sk-or-')) {
      throw new Error(
        'OpenRouterProvider requires an OpenRouter API key starting with sk-or-',
      );
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const endpoint = this.opts.endpoint ?? 'https://openrouter.ai/api/v1/chat/completions';
    const body = {
      model: req.model,
      messages: req.messages.map(mapMessageToOpenAI),
      temperature: req.temperature ?? 0.2,
      // OpenRouter's default max_tokens is the model's full context
      // window, which triggers 402 "requires more credits" on budget-
      // capped accounts. Cap at 2048 — enough for a tick's tool calls
      // or a chat reply; user-configurable via opts.maxTokens if a
      // longer response is ever needed.
      max_tokens: this.opts.maxTokens ?? 2048,
      // ── Usage accounting opt-in (ticket 01KQVM1Z8SZ8WF89G005WCVWSH) ──
      // Without `usage: { include: true }` OpenRouter returns only
      // token counts in `usage` and the `cost` field is omitted
      // entirely. Pre-fix code was reading the non-existent
      // `usage.total_cost`, so `costUsd` was always 0 → the spend
      // ledger never wrote a row → `mo_spend_ledger` was empty in
      // production despite real OR charges. Adding this flag costs
      // nothing (OR has surfaced it as a stable API since 2024) and
      // makes per-call cost + cache + reasoning details available.
      usage: { include: true },
      tools: req.tools?.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: req.tools && req.tools.length > 0 ? 'auto' : undefined,
    };
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        // OpenRouter attribution headers — polite to include. Leave
        // empty by default; user can set via opts to surface the app
        // in OpenRouter's dashboard.
        ...(this.opts.httpReferer ? { 'http-referer': this.opts.httpReferer } : {}),
        ...(this.opts.xTitle ? { 'x-title': this.opts.xTitle } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`OpenRouter ${resp.status}: ${text.slice(0, 500)}`);
    }
    const json = (await resp.json()) as OpenRouterChatResponse;
    const choice = json.choices?.[0];
    const message = choice?.message ?? { role: 'assistant', content: '' };
    const toolCalls: LLMToolCall[] = (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      argumentsJson: call.function.arguments ?? '{}',
    }));
    const usage = json.usage ?? {};
    const tokensIn = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
    const tokensOut = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
    const modelEcho = json.model ?? req.model;
    // OpenRouter's authoritative cost is `usage.cost` (USD), surfaced
    // when the request opted in with `usage: { include: true }`. For
    // BYOK setups (`usage.is_byok === true`) `cost` reports the OR
    // markup charge (typically 0); the upstream provider's bill is in
    // `usage.cost_details.upstream_inference_cost`. Prefer `cost`,
    // fall back to upstream when zero+BYOK, fall back to 0 last (free-
    // tier model on a non-BYOK key).
    let costUsd = 0;
    if (typeof usage.cost === 'number') {
      costUsd = usage.cost;
      if (
        costUsd === 0 &&
        usage.is_byok === true &&
        typeof usage.cost_details?.upstream_inference_cost === 'number'
      ) {
        costUsd = usage.cost_details.upstream_inference_cost;
      }
    }
    const cachedTokens =
      typeof usage.prompt_tokens_details?.cached_tokens === 'number'
        ? usage.prompt_tokens_details.cached_tokens
        : null;
    const cacheWriteTokens =
      typeof usage.prompt_tokens_details?.cache_write_tokens === 'number'
        ? usage.prompt_tokens_details.cache_write_tokens
        : null;
    const reasoningTokens =
      typeof usage.completion_tokens_details?.reasoning_tokens === 'number'
        ? usage.completion_tokens_details.reasoning_tokens
        : null;
    return {
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls,
      tokensIn,
      tokensOut,
      costUsd,
      model: modelEcho,
      cachedTokens,
      cacheWriteTokens,
      reasoningTokens,
      providerName: this.name,
    };
  }
}

export interface OpenRouterOptions {
  endpoint?: string;
  httpReferer?: string;
  xTitle?: string;
  /** Cap output length. Default 2048 tokens — chat replies + one
   * tick's worth of tool calls fit well inside this; raise only when
   * a specific workflow needs longer assistant output. */
  maxTokens?: number;
}

function mapMessageToOpenAI(m: LLMMessage): OpenAIMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      content: m.content,
      tool_call_id: m.toolCallId ?? undefined,
    };
  }
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.toolCalls?.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: call.argumentsJson,
        },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

// ---- OpenAI-compatible wire shapes (narrow subset we actually use) ---

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenRouterChatResponse {
  model?: string;
  choices?: Array<{
    message?: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  /** OR response usage block, populated only when the request body
   *  carried `usage: { include: true }`. The legacy `total_cost`
   *  field that earlier code chased never existed — OR's canonical
   *  fields are `cost` + `cost_details` per their API reference. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    is_byok?: boolean;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
    cost_details?: {
      upstream_inference_cost?: number | null;
      upstream_inference_prompt_cost?: number;
      upstream_inference_completions_cost?: number;
    };
  };
}

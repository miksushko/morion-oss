import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
} from './provider.js';

/**
 * Direct OpenAI backend (skip OpenRouter middleman).
 *
 * OpenAI's Chat Completions API
 * (`https://api.openai.com/v1/chat/completions`) is the same wire shape
 * Groq exposes — same messages, same tool_calls roundtrip — so this
 * provider is structurally a clone of GroqProvider with two material
 * differences:
 *
 *   1. **Reasoning-model branch.** gpt-5*, o1*, o3*, o4* require
 *      `max_completion_tokens` instead of legacy `max_tokens` (the
 *      latter is silently ignored on those models, response then hits
 *      the model's full context cap and gets server-rejected). Same
 *      gotcha Groq's `openai/gpt-oss-*` has, just with more model ids.
 *   2. **Reasoning models ignore temperature.** Only the default (1.0)
 *      is supported; sending any other value 400s. Drop the field
 *      entirely for those models.
 *
 * Why ship this when OpenRouter already supports OpenAI models? Three
 * reasons:
 *   - **Direct pricing** — no OpenRouter ~5% markup. Mo's $10/mo cap
 *     stretches further on heavy users.
 *   - **Latest models land here first.** gpt-5.2's xhigh reasoning
 *     effort, gpt-5.5 — these surface on api.openai.com before
 *     OpenRouter's catalog catches up.
 *   - **Cached-input pricing** flows correctly. OpenRouter sometimes
 *     proxies cache markers through, sometimes silently strips, and
 *     the user can't tell from the response. Direct = honest.
 *
 * Ticket: `01KQ4YJ76KZPQE6TH3W1D5R2G1`.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly opts: OpenAIOptions = {},
  ) {
    // OpenAI keys are `sk-...` (legacy) or `sk-proj-...` (project-
    // scoped). Reject anything else early so the user sees a clear
    // error instead of a 401 in the chat panel.
    if (!apiKey || !apiKey.startsWith('sk-')) {
      throw new Error('OpenAIProvider requires an API key starting with sk-');
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const endpoint = this.opts.endpoint ?? 'https://api.openai.com/v1/chat/completions';
    const cap = this.opts.maxTokens ?? 2048;
    const isReasoningModel = isOpenAIReasoningModel(req.model);
    // Reasoning models — gpt-5*, o1*, o3*, o4* — use the new field
    // name and ignore temperature. The two are linked: same model
    // family, same constraint set. Sending `temperature: 0.2` against
    // gpt-5 returns a 400 with `'temperature' is not supported with this
    // model`. Drop both wrong fields together.
    const body: Record<string, unknown> = {
      model: req.model,
      // Reasoning models (gpt-5*, o-series) treat `role: 'system'` as
      // ADVISORY rather than authoritative — instructions get followed
      // sometimes, ignored when they clash with the model's defaults.
      // Per OpenAI's reasoning-model docs, `role: 'developer'` is the
      // authoritative-instruction channel for these models. Same wire
      // shape, stronger compliance. Without this swap, Mo's memory
      // block ("user prefers месье form of address") gets ignored on
      // gpt-5 even though the prompt is right there. Legacy models
      // (gpt-4.1, gpt-4o, etc.) still want `role: 'system'`. 2026-04-26.
      messages: req.messages.map((m) => mapMessageToOpenAI(m, isReasoningModel)),
      ...(isReasoningModel
        ? { max_completion_tokens: cap }
        : { max_tokens: cap, temperature: req.temperature ?? 0.2 }),
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
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 500)}`);
    }
    const json = (await resp.json()) as OpenAIChatResponse;
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
    const price = this.opts.pricing?.[req.model] ?? OPENAI_DEFAULT_PRICING[req.model];
    const costUsd = price
      ? ((tokensIn ?? 0) * price.input + (tokensOut ?? 0) * price.output) /
        1_000_000
      : 0;
    const cachedTokens =
      typeof usage.prompt_tokens_details?.cached_tokens === 'number'
        ? usage.prompt_tokens_details.cached_tokens
        : null;
    const reasoningTokens =
      typeof usage.completion_tokens_details?.reasoning_tokens === 'number'
        ? usage.completion_tokens_details.reasoning_tokens
        : null;
    return {
      content:
        typeof message.content === 'string'
          ? dedupeRepeatedHalf(message.content)
          : '',
      toolCalls,
      tokensIn,
      tokensOut,
      costUsd,
      model: modelEcho,
      cachedTokens,
      // OpenAI doesn't bill cache writes as a separate line (read-only
      // cache model), so this stays null.
      cacheWriteTokens: null,
      reasoningTokens,
      providerName: this.name,
    };
  }
}

/**
 * gpt-5 reasoning models (observed on `gpt-5.4-mini-2026-03-17` at
 * ~20% rate, 2026-04-26) occasionally emit a `content` string where
 * the entire reply is duplicated verbatim — line-for-line first
 * half == second half, joined by a single `\n`. `finish_reason` is
 * `"stop"`, `choices.length` is 1, no tool_calls, no array-content
 * shape — the model just sometimes ships its draft AND final as one
 * concatenated string. Cheap server-side dedupe is the right layer:
 * the user shouldn't have to debug a model-side glitch, and our
 * dispatch / persistence / re-feed paths all assume `content` is the
 * single visible reply.
 *
 * Algorithm: split on `\n`; if the line array has even length and
 * first half === second half element-by-element, return the first
 * half joined back. Otherwise return the input unchanged. Pure
 * function, idempotent on already-deduped strings, exported for
 * direct unit testing.
 */
export function dedupeRepeatedHalf(text: string): string {
  if (text.length < 2) return text;
  const lines = text.split('\n');
  if (lines.length < 2 || lines.length % 2 !== 0) return text;
  const half = lines.length / 2;
  for (let i = 0; i < half; i++) {
    if (lines[i] !== lines[i + half]) return text;
  }
  return lines.slice(0, half).join('\n');
}

export interface OpenAIPricing {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

export interface OpenAIOptions {
  endpoint?: string;
  maxTokens?: number;
  /** Override per-model pricing. Merged over OPENAI_DEFAULT_PRICING. */
  pricing?: Record<string, OpenAIPricing>;
}

/**
 * Pricing map (USD per million tokens) as published on
 * https://openai.com/api/pricing/ . Update when OpenAI changes prices
 * or ships new models. Missing entries fall through to $0 — the budget
 * tracker stays honest, but unknown-model spend isn't billed correctly,
 * so add rows eagerly.
 */
export const OPENAI_DEFAULT_PRICING: Record<string, OpenAIPricing> = {
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  o3: { input: 5, output: 20 },
  'o3-mini': { input: 1.1, output: 4.4 },
  o1: { input: 15, output: 60 },
  'o1-mini': { input: 1.1, output: 4.4 },
};

/**
 * Reasoning-model detector — drives both the `max_completion_tokens`
 * vs `max_tokens` field choice AND whether we drop the `temperature`
 * field. Conservative prefix match: anything starting with `gpt-5`,
 * `o1`, `o3`, `o4` is treated as reasoning. `gpt-4.1` etc. take the
 * legacy fields. Update as new families ship.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  return (
    model.startsWith('gpt-5') ||
    /^o[1-9](-|$)/.test(model)
  );
}

function mapMessageToOpenAI(m: LLMMessage, useDeveloperRole: boolean): OpenAIMessage {
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
  // For reasoning models (gpt-5*, o-series), `developer` is the
  // authoritative-instruction role — `system` is treated as advisory
  // and gets ignored when it clashes with the model's defaults. For
  // legacy models (gpt-4.1, gpt-4o, etc.), `developer` isn't recognised
  // and the API 400s, so keep `system` for them.
  if (m.role === 'system' && useDeveloperRole) {
    return { role: 'developer', content: m.content };
  }
  return { role: m.role, content: m.content };
}

interface OpenAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIChatResponse {
  model?: string;
  choices?: Array<{
    message?: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** OpenAI surfaces cached prompt tokens for prompt-caching-eligible
     *  models (chat-cached). Added by Slice 3 of ticket
     *  01KRJSTN74FT7VRX6KAA42GGBS to feed the Usage cache-hit metric. */
    prompt_tokens_details?: {
      cached_tokens?: number;
      audio_tokens?: number;
    };
    /** Reasoning models (o1 / o3 / gpt-5) surface hidden reasoning
     *  token counts here. NOT included in `completion_tokens`. */
    completion_tokens_details?: {
      reasoning_tokens?: number;
      audio_tokens?: number;
    };
  };
}

import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
} from './provider.js';

/**
 * Direction V — Groq provider (direct LPU inference, faster than
 * OpenRouter routing).
 *
 * Groq hosts the model on their custom Language Processing Unit
 * hardware and exposes an OpenAI-compatible chat-completions endpoint
 * at `https://api.groq.com/openai/v1/chat/completions`. Tokens-per-
 * second on the open-weight models Groq serves run 10-20× faster than
 * Kimi K2.5 on OpenRouter — 500 TPS on GPT-OSS-120B, 594 TPS on
 * Llama 4 Scout, 840 TPS on Llama 3.1 8B Instant.
 *
 * Groq does NOT expose per-call cost in the `usage` block (their
 * billing is invoice-based + tokens). We compute cost ourselves from
 * published per-M-token prices, set in `GroqOptions.pricing` with the
 * GPT-OSS-120B defaults baked in. Add rows here when new models land.
 *
 * API key lives in `settings.concierge.groq_api_key` or the `GROQ_KEY`
 * env var (matches the name the operator set in `.env`). Never
 * committed.
 */
export class GroqProvider implements LLMProvider {
  readonly name = 'groq';

  constructor(
    private readonly apiKey: string,
    private readonly opts: GroqOptions = {},
  ) {
    if (!apiKey || !apiKey.startsWith('gsk_')) {
      throw new Error('GroqProvider requires an API key starting with gsk_');
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const endpoint = this.opts.endpoint ?? 'https://api.groq.com/openai/v1/chat/completions';
    // OpenAI's reasoning-family models (gpt-oss-*) use
    // `max_completion_tokens`, not legacy `max_tokens`. Sending the
    // wrong field is silently ignored on those models → response hits
    // the 64K default ceiling → gets rejected server-side. Route by
    // model prefix.
    //
    // Cap defaults to 2000 because Groq's free tier enforces 8000 TPM
    // COMBINED (prompt + completion). Reserving 8000 just for output
    // leaves no room for the system prompt + CHAT_TOOLS schema +
    // history — every request would 413. 2000 leaves ~6000 TPM for
    // input, which fits Mo's ~2KB system prompt (~500 tokens) + tools
    // spec (~500 tokens) + ~5000 tokens of history. Upgrade to Dev
    // Tier lifts the cap; raise maxTokens via opts then.
    const cap = this.opts.maxTokens ?? 2000;
    const isReasoningModel = req.model.startsWith('openai/gpt-oss');
    const tokenCapField = isReasoningModel
      ? { max_completion_tokens: cap }
      : { max_tokens: cap };
    const body = {
      model: req.model,
      messages: req.messages.map(mapMessageToOpenAI),
      temperature: req.temperature ?? 0.2,
      ...tokenCapField,
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
      throw new Error(`Groq ${resp.status}: ${text.slice(0, 500)}`);
    }
    const json = (await resp.json()) as GroqChatResponse;
    const choice = json.choices?.[0];
    const message = choice?.message ?? { role: 'assistant', content: '' };
    const toolCalls: LLMToolCall[] = (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      argumentsJson: call.function.arguments ?? '{}',
    }));
    const usage = json.usage ?? { prompt_tokens: null, completion_tokens: null };
    const tokensIn = usage.prompt_tokens ?? null;
    const tokensOut = usage.completion_tokens ?? null;
    const modelEcho = json.model ?? req.model;
    const price = this.opts.pricing?.[req.model] ?? DEFAULT_PRICING[req.model];
    const costUsd = price
      ? ((tokensIn ?? 0) * price.input + (tokensOut ?? 0) * price.output) /
        1_000_000
      : 0;
    return {
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls,
      tokensIn,
      tokensOut,
      costUsd,
      model: modelEcho,
      // Groq has no prompt-cache or reasoning-token surface at the
      // wire level (as of 2026-05). All three stay null; aggregator
      // treats null as "not captured" so cache-hit % omits Groq rows
      // from the denominator instead of flooring them at 0%.
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      providerName: this.name,
    };
  }
}

export interface GroqPricing {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

export interface GroqOptions {
  endpoint?: string;
  maxTokens?: number;
  /** Override per-model pricing. Merged over DEFAULT_PRICING. */
  pricing?: Record<string, GroqPricing>;
}

/**
 * Pricing map (USD per million tokens) as published on
 * https://groq.com/pricing . Update when Groq changes prices or adds
 * new models we route to. Missing entries fall through to $0 which
 * keeps the budget tracker honest but isn't realistic — add rows
 * eagerly.
 */
export const DEFAULT_PRICING: Record<string, GroqPricing> = {
  'openai/gpt-oss-120b': { input: 0.15, output: 0.6 },
  'openai/gpt-oss-20b': { input: 0.075, output: 0.3 },
  'meta-llama/llama-4-scout-17b-16e-instruct': { input: 0.11, output: 0.34 },
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
  'qwen/qwen3-32b': { input: 0.29, output: 0.59 },
};

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

interface GroqChatResponse {
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
  };
}

import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
} from './provider.js';

/**
 * Local-first Mo backend via Ollama.
 *
 * Ollama exposes an OpenAI-compatible chat endpoint at
 * `${baseUrl}/v1/chat/completions` (since v0.1.32 / 2024). Wire shape is
 * identical to GroqProvider / OpenRouterProvider — same messages array,
 * same tool_calls roundtrip — so the implementation is a near-clone of
 * those, minus the `Authorization: Bearer` header (no key required) and
 * with `costUsd` hard-pinned to 0 (running on the user's own hardware).
 *
 * Why this exists: users who explicitly want a fully local Morion (no
 * network egress for Mo at all) — air-gapped workstations, paranoid
 * privacy, "I have a 64GB M1 Max sitting idle" power-users. Cloud
 * providers (Groq, OpenRouter) stay the recommended default for
 * latency + tool-calling quality; Ollama is the escape hatch.
 *
 * Default base URL is `http://localhost:11434` (Ollama's stock listen
 * address). Override via `MORION_OLLAMA_BASE_URL` env or the per-backend
 * settings key for shops that run Ollama on a separate machine on the
 * LAN. We do NOT ship a "discover Ollama" button — too fragile across
 * OSes; manual config is one input field.
 *
 * Tool-calling caveat: Ollama's tool support is real but model-quality
 * varies wildly. Qwen 2.5 (especially 14B+ instruct variants) and
 * Llama 3.1 8B instruct work well; reasoning-distill models like
 * deepseek-r1 emit `<think>` blocks that confuse the OpenAI-compat
 * tool_calls path. This provider does NOT filter `<think>` — that's a
 * model-choice issue we surface in the UI copy ("pick a tool-calling
 * model like qwen2.5:14b") rather than work around.
 *
 * Cost is always 0 — local inference has no per-call upstream charge.
 * The spend ledger still records the call (kind='mo_tool' / 'chat' /
 * etc.) at $0 so the "What Mo did" surface shows the activity, but the
 * monthly cap can never be hit. Hard-cap gates (`requireBudget` in
 * mo_ask / mo_record / mo_remember) skip cleanly because $0 + $0 + ...
 * never reaches $10.
 */
export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';

  constructor(private readonly opts: OllamaOptions = {}) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const baseUrl = (this.opts.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(
      /\/+$/,
      '',
    );
    const endpoint = `${baseUrl}/v1/chat/completions`;
    const body = {
      model: req.model,
      messages: req.messages.map(mapMessageToOpenAI),
      temperature: req.temperature ?? 0.2,
      // Ollama defaults `num_predict` to -1 (unlimited) which can hang
      // a tick if the model gets chatty. Cap at 2048 like OpenRouter —
      // chat reply or one round of tool calls fits.
      max_tokens: this.opts.maxTokens ?? 2048,
      tools: req.tools?.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: req.tools && req.tools.length > 0 ? 'auto' : undefined,
    };
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`Ollama ${resp.status}: ${text.slice(0, 500)}`);
    }
    const json = (await resp.json()) as OllamaChatResponse;
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
    return {
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls,
      tokensIn,
      tokensOut,
      // Local inference — no upstream cost. Ledger row at $0 still
      // records the activity for the "What Mo did" surface; the budget
      // cap can never be hit by ollama traffic.
      costUsd: 0,
      model: modelEcho,
      // Local inference exposes no prompt cache or reasoning token
      // accounting at the OpenAI-compat layer Ollama serves.
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      providerName: this.name,
    };
  }
}

// 127.0.0.1, NOT `localhost` — Ollama binds only to IPv4 by default
// (`tcp 127.0.0.1:11434`). On macOS, Node's undici fetch can resolve
// `localhost` to `::1` (IPv6) first → ECONNREFUSED because no IPv6
// listener exists. Forcing IPv4 sidesteps the trap. Users with a
// remote / network-accessible Ollama can override via the Base URL
// field; users running stock local Ollama get the right behavior
// out of the box.
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export interface OllamaOptions {
  /** Base URL of the Ollama HTTP server. Default
   * `http://localhost:11434`. Trailing slashes stripped. */
  baseUrl?: string;
  /** Cap output length. Default 2048 tokens. */
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

interface OllamaChatResponse {
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

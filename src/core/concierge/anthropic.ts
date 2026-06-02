import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMToolCall,
} from './provider.js';

/**
 * Direct Anthropic backend — Claude Messages API.
 *
 * Unlike the other backends (Groq, OpenRouter, OpenAI, Ollama) which
 * all consume the OpenAI-compatible Chat Completions wire shape, the
 * Anthropic Messages API has its own structure that we have to
 * translate to/from `LLMMessage[]`. This file is the translation
 * boundary — every other Mo code path stays in the OpenAI-shaped
 * `LLMMessage` model.
 *
 * Endpoint:    `https://api.anthropic.com/v1/messages`
 * Auth header: `x-api-key: <key>`  (NOT `Authorization: Bearer ...`)
 * Required:    `anthropic-version: 2023-06-01`, `content-type: application/json`
 * Key prefix:  `sk-ant-`
 *
 * Material differences from Chat Completions:
 *
 *   1. **`system` is a top-level string** — not a message with role.
 *      Multiple consecutive `role='system'` LLMMessages get joined
 *      with `\n\n` and lifted out of the `messages` array.
 *
 *   2. **Tool definitions use `input_schema`, not `parameters`.**
 *      Same JSON Schema body, different field name. One-line rename
 *      in the request mapper.
 *
 *   3. **Tool calls come back as `tool_use` content BLOCKS inside the
 *      assistant's `content` array**, not a separate `tool_calls`
 *      field. Assistant content is `Array<{type: 'text'} | {type:
 *      'tool_use'}>`. We flatten: text blocks → `LLMResponse.content`
 *      (concat); tool_use blocks → `LLMResponse.toolCalls`.
 *
 *   4. **Tool results go back as `tool_result` content BLOCKS inside a
 *      USER message**, not a separate `role='tool'` message. The OpenAI
 *      shape has one tool result per message; the Anthropic shape
 *      coalesces consecutive `role='tool'` LLMMessages into a single
 *      user message with multiple tool_result blocks. Sending them as
 *      separate user messages 400s — Claude rejects two consecutive
 *      same-role messages.
 *
 *   5. **`max_tokens` is REQUIRED** (no default). Cap at 2048 like the
 *      other providers; opt out via `OllamaOptions.maxTokens`.
 *
 *   6. **Stop reason matters for tool loop.** `stop_reason: 'tool_use'`
 *      means the assistant wants tool results back. Not surfaced
 *      explicitly here — `LLMResponse.toolCalls.length > 0` is the
 *      same signal the engine reads anyway.
 *
 * Why ship this when OpenRouter already proxies Claude?
 *   - **Direct pricing** — no OpenRouter markup.
 *   - **Cache markers flow correctly.** Anthropic's `cache_control:
 *     ephemeral` markers on system prompt + persistent context are a
 *     real win for Mo's heavy system prompt; OpenRouter sometimes
 *     proxies, sometimes silently strips. (Caching itself is deferred
 *     out of v1 — but the path becomes available.)
 *   - **Latest models land here first.** Opus 4.7, Sonnet 4.6, Haiku
 *     4.5 — all present on api.anthropic.com before OpenRouter's
 *     catalog catches up.
 *
 * Ticket: `01KQ4YJ76KZPQE6TH3W1D5R2G1`.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly opts: AnthropicOptions = {},
  ) {
    if (!apiKey || !apiKey.startsWith('sk-ant-')) {
      throw new Error('AnthropicProvider requires an API key starting with sk-ant-');
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const endpoint = this.opts.endpoint ?? 'https://api.anthropic.com/v1/messages';
    const { system, messages } = transformMessagesToAnthropic(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: this.opts.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.2,
      messages,
      ...(system ? { system } : {}),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              // Claude's field name is `input_schema`; OpenAI/Groq call
              // it `parameters`. Same JSON Schema body — just a rename.
              input_schema: t.parameters,
            })),
            tool_choice: { type: 'auto' as const },
          }
        : {}),
    };
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.opts.anthropicVersion ?? '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 500)}`);
    }
    const json = (await resp.json()) as AnthropicMessageResponse;
    // Walk the content blocks: text blocks concat into the response
    // string; tool_use blocks become flat LLMToolCall[]. Other block
    // types (extended thinking summaries, server-tool blocks) are
    // ignored for v1 — we don't surface them to Mo.
    let textBuf = '';
    const toolCalls: LLMToolCall[] = [];
    for (const rawBlock of json.content ?? []) {
      // Cast through the catch-all union variant by re-reading the
      // discriminated fields with explicit type guards. The wire shape
      // declares `text` / `id` / `name` only on the narrow variants,
      // but TS keeps them `unknown` after `type === '...'` because the
      // catch-all `{type: string; [k: string]: unknown}` overlaps. So
      // we type-narrow each field defensively.
      const block = rawBlock as Record<string, unknown> & { type: string };
      if (block.type === 'text' && typeof block.text === 'string') {
        textBuf += block.text;
      } else if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string'
      ) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          // Claude returns `input` as a parsed object; engine expects
          // a JSON STRING in argumentsJson (matches OpenAI shape).
          // Stringify on the way out, callers parse on the way in.
          argumentsJson: JSON.stringify(block.input ?? {}),
        });
      }
    }
    const usage = json.usage ?? {};
    const tokensIn = typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
    const tokensOut = typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
    const modelEcho = json.model ?? req.model;
    const price =
      this.opts.pricing?.[req.model] ?? ANTHROPIC_DEFAULT_PRICING[req.model];
    const costUsd = price
      ? ((tokensIn ?? 0) * price.input + (tokensOut ?? 0) * price.output) /
        1_000_000
      : 0;
    // Anthropic surfaces cache reads + cache writes as two separate
    // billing lines. `cache_read_input_tokens` is what we want for
    // the cache-hit % metric; `cache_creation_input_tokens` is the
    // one-time write cost. Both null when the model doesn't support
    // caching or no cache block was attached to the request.
    const cachedTokens =
      typeof usage.cache_read_input_tokens === 'number'
        ? usage.cache_read_input_tokens
        : null;
    const cacheWriteTokens =
      typeof usage.cache_creation_input_tokens === 'number'
        ? usage.cache_creation_input_tokens
        : null;
    return {
      content: textBuf,
      toolCalls,
      tokensIn,
      tokensOut,
      costUsd,
      model: modelEcho,
      cachedTokens,
      cacheWriteTokens,
      // Anthropic doesn't bill reasoning tokens as a separate line —
      // extended-thinking is metered through regular output_tokens.
      reasoningTokens: null,
      providerName: this.name,
    };
  }
}

export interface AnthropicPricing {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

export interface AnthropicOptions {
  endpoint?: string;
  /** Override anthropic-version header. Default `2023-06-01` (still
   * the current stable version through 2026; beta headers like
   * `output-300k-2026-03-24` go on top of it, not in place of it). */
  anthropicVersion?: string;
  /** Cap output length. Anthropic REQUIRES this — there's no "use the
   * model's context window" default. 2048 matches the other providers. */
  maxTokens?: number;
  pricing?: Record<string, AnthropicPricing>;
}

/**
 * Pricing map (USD per million tokens) per
 * https://www.anthropic.com/pricing . Update when Anthropic changes
 * prices or ships new models.
 */
export const ANTHROPIC_DEFAULT_PRICING: Record<string, AnthropicPricing> = {
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-opus-4-5': { input: 15, output: 75 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
};

// ---------------------------------------------------------------------
// Translation: LLMMessage[] → {system, messages[]}
// ---------------------------------------------------------------------

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/**
 * Pure function — exported for direct unit testing of edge cases that
 * are awkward to exercise through `complete()` (e.g. multi-system,
 * coalesced tool results, assistant turns with mixed text + tool_use).
 *
 * Walks the LLMMessage[] in order and produces:
 *   - `system`: concatenation of every `role='system'` message body,
 *     joined by `\n\n`. Empty string → undefined return on caller side.
 *   - `messages`: alternating user/assistant turns. Consecutive
 *     `role='tool'` LLMMessages from one assistant tool-use turn get
 *     coalesced into ONE user message with multiple `tool_result`
 *     blocks (Claude rejects consecutive same-role messages, so a
 *     loose mapping where each tool result becomes its own user
 *     message would 400 with `messages: roles must alternate`).
 *
 * Assistant turns with `toolCalls` produce a content array that
 * starts with the text (if any) and is followed by `tool_use` blocks
 * — same pattern Claude itself emits in responses, which is what the
 * Anthropic API expects in subsequent turns echoing prior tool calls
 * back to Claude.
 */
export function transformMessagesToAnthropic(
  msgs: readonly LLMMessage[],
): { system: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const m of msgs) {
    if (m.role === 'system') {
      if (m.content.length > 0) systemParts.push(m.content);
      continue;
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const blocks: AnthropicContentBlock[] = [];
        if (m.content.length > 0) {
          blocks.push({ type: 'text', text: m.content });
        }
        for (const call of m.toolCalls) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(call.argumentsJson || '{}');
          } catch {
            // Defensive: keep the raw string if JSON is malformed
            // (shouldn't happen — providers MUST emit valid JSON in
            // argumentsJson — but we don't want to crash the whole
            // chat history replay over one corrupt row).
            parsed = {};
          }
          blocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: parsed,
          });
        }
        out.push({ role: 'assistant', content: blocks });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
      continue;
    }
    if (m.role === 'tool') {
      // Coalesce: if the previous output message is already a user
      // message holding tool_result blocks, append to it. Otherwise
      // open a fresh user message. This is the critical bit —
      // emitting two separate user messages for back-to-back tool
      // results would 400 the request.
      const block: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
      };
      const last = out[out.length - 1];
      if (
        last &&
        last.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.every((b) => b.type === 'tool_result')
      ) {
        (last.content as AnthropicContentBlock[]).push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
  }

  return {
    system: systemParts.join('\n\n'),
    messages: out,
  };
}

// ---------------------------------------------------------------------
// Wire shapes (narrow subset we actually consume)
// ---------------------------------------------------------------------

interface AnthropicMessageResponse {
  model?: string;
  /** Top-level array of content blocks in the assistant's reply.
   * Block types we care about: `text` (plain prose), `tool_use`
   * (function call). Other types (extended thinking summaries,
   * server-tool result blocks) are silently dropped — Mo doesn't
   * surface them. */
  content?: Array<
    | { type: 'text'; text?: string }
    | { type: 'tool_use'; id: string; name: string; input?: unknown }
    | { type: string; [k: string]: unknown }
  >;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

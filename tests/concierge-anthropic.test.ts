/**
 * AnthropicProvider — direct Claude Messages API backend.
 *
 * Unlike the other providers (which all consume OpenAI Chat Completions
 * wire shape), Anthropic has its own format. These tests pin the
 * translation layer:
 *
 *   1. **System message extraction** — `role='system'` LLMMessages
 *      are lifted out of the messages array and concatenated into
 *      a top-level `system` field. Multiple system messages join with
 *      `\n\n`.
 *   2. **Tool definition rename** — `parameters` → `input_schema`.
 *   3. **Assistant tool_use blocks** — when an LLMMessage has
 *      `toolCalls`, the content becomes a content-block array with
 *      `{type: 'tool_use', id, name, input: <parsed>}` blocks.
 *   4. **Consecutive tool_result coalesce** — back-to-back `role='tool'`
 *      LLMMessages MUST coalesce into ONE user message with multiple
 *      `tool_result` blocks. Sending them as separate user messages
 *      400s with `messages: roles must alternate`.
 *   5. **Response parsing** — Claude's content array (text + tool_use
 *      blocks) flattens back to `LLMResponse.content` (concatenated
 *      text) + `LLMResponse.toolCalls` (flat).
 *   6. **Auth headers** — `x-api-key` (NOT Bearer), `anthropic-version:
 *      2023-06-01`, `content-type: application/json`.
 *   7. **Cost from input_tokens / output_tokens** (Claude's usage shape
 *      uses different field names than OpenAI).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  AnthropicProvider,
  transformMessagesToAnthropic,
} from '../src/core/concierge/anthropic.js';
import { NoopLLMProvider } from '../src/core/concierge/provider.js';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { readProviderModel, readConfiguredProvider } from '../src/server/features/concierge-deps/index.js';
import type { ConciergeDepsHost } from '../src/server/features/concierge-deps/index.js';
import type { LLMMessage } from '../src/core/concierge/provider.js';

function makeHost(settings: SettingsRepository): ConciergeDepsHost {
  return {
    db: undefined as never,
    notes: undefined as never,
    folders: undefined as never,
    comments: undefined as never,
    settings,
    concierge: {
      folderSettings: undefined as never,
      sessions: undefined as never,
      messages: undefined as never,
      actions: undefined as never,
      moMemory: undefined as never,
      budget: undefined as never,
    },
  };
}

describe('transformMessagesToAnthropic — translation layer', () => {
  it('extracts system messages into top-level system field', () => {
    const msgs: LLMMessage[] = [
      { role: 'system', content: 'You are Mo.' },
      { role: 'user', content: 'hi' },
    ];
    const out = transformMessagesToAnthropic(msgs);
    expect(out.system).toBe('You are Mo.');
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('concatenates multiple system messages with \\n\\n', () => {
    const msgs: LLMMessage[] = [
      { role: 'system', content: 'You are Mo.' },
      { role: 'system', content: 'Workspace memory: user prefers terse.' },
      { role: 'user', content: 'go' },
    ];
    const out = transformMessagesToAnthropic(msgs);
    expect(out.system).toBe('You are Mo.\n\nWorkspace memory: user prefers terse.');
    expect(out.messages).toHaveLength(1);
  });

  it('returns empty system string when no system messages present', () => {
    const msgs: LLMMessage[] = [{ role: 'user', content: 'x' }];
    expect(transformMessagesToAnthropic(msgs).system).toBe('');
  });

  it('skips empty system content (does not produce trailing \\n\\n)', () => {
    const msgs: LLMMessage[] = [
      { role: 'system', content: '' },
      { role: 'system', content: 'real' },
      { role: 'user', content: 'x' },
    ];
    expect(transformMessagesToAnthropic(msgs).system).toBe('real');
  });

  it('plain assistant message → string content', () => {
    const msgs: LLMMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const out = transformMessagesToAnthropic(msgs);
    expect(out.messages[1]).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('assistant with toolCalls → content array of tool_use blocks (parsed input)', () => {
    const msgs: LLMMessage[] = [
      { role: 'user', content: 'find foo' },
      {
        role: 'assistant',
        content: 'Looking it up.',
        toolCalls: [{
          id: 'toolu_abc',
          name: 'notes_search',
          argumentsJson: '{"query":"foo"}',
        }],
      },
    ];
    const out = transformMessagesToAnthropic(msgs);
    expect(out.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking it up.' },
        { type: 'tool_use', id: 'toolu_abc', name: 'notes_search', input: { query: 'foo' } },
      ],
    });
  });

  it('assistant with toolCalls but no text → only tool_use blocks (no empty text block)', () => {
    const msgs: LLMMessage[] = [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'foo', argumentsJson: '{}' }],
      },
    ];
    const out = transformMessagesToAnthropic(msgs);
    expect(out.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'foo', input: {} }],
    });
  });

  it('CONSECUTIVE tool messages coalesce into ONE user message with multiple tool_result blocks', () => {
    // The 400 trap: Claude rejects two consecutive same-role messages.
    // If our chat history has assistant emitting 2 tool_calls and then
    // 2 separate role='tool' rows, we MUST merge them into one user.
    const msgs: LLMMessage[] = [
      { role: 'user', content: 'multi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 't1', name: 'foo', argumentsJson: '{}' },
          { id: 't2', name: 'bar', argumentsJson: '{}' },
        ],
      },
      { role: 'tool', content: 'foo result', toolCallId: 't1' },
      { role: 'tool', content: 'bar result', toolCallId: 't2' },
      { role: 'assistant', content: 'done' },
    ];
    const out = transformMessagesToAnthropic(msgs);
    // user("multi") → assistant(2 tool_use) → user(2 tool_result) → assistant("done")
    expect(out.messages).toHaveLength(4);
    expect(out.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'foo result' },
        { type: 'tool_result', tool_use_id: 't2', content: 'bar result' },
      ],
    });
  });

  it('a tool message followed by an assistant message followed by another tool message does NOT cross-coalesce', () => {
    // Edge case: tool / assistant / tool. The two tool results belong
    // to DIFFERENT assistant turns and must produce separate user
    // messages.
    const msgs: LLMMessage[] = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'a', argumentsJson: '{}' }] },
      { role: 'tool', content: 'r1', toolCallId: 't1' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't2', name: 'b', argumentsJson: '{}' }] },
      { role: 'tool', content: 'r2', toolCallId: 't2' },
    ];
    const out = transformMessagesToAnthropic(msgs);
    expect(out.messages).toHaveLength(5);
    // First tool_result user message
    expect(out.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }],
    });
    // Second tool_result user message — distinct, NOT merged with first
    expect(out.messages[4]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't2', content: 'r2' }],
    });
  });

  it('malformed argumentsJson defaults to {} without crashing', () => {
    const msgs: LLMMessage[] = [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'foo', argumentsJson: 'NOT VALID JSON' }],
      },
    ];
    const out = transformMessagesToAnthropic(msgs);
    expect(out.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'foo', input: {} }],
    });
  });
});

describe('AnthropicProvider — wire format', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects key without sk-ant- prefix at construction', () => {
    expect(() => new AnthropicProvider('sk-test')).toThrow(/sk-ant-/);
    expect(() => new AnthropicProvider('not-a-key')).toThrow(/sk-ant-/);
  });

  it('POSTs to /v1/messages with x-api-key + anthropic-version (NOT Bearer)', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn(async (url, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')),
        headers: init?.headers as Record<string, string>,
      });
      return new Response(
        JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider('sk-ant-test123');
    const resp = await provider.complete({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    // Bearer auth would be wrong — Anthropic uses x-api-key
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-test123');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(resp.content).toBe('pong');
  });

  it('lifts system messages to top-level system field, not into messages[]', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(
        JSON.stringify({
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider('sk-ant-test');
    await provider.complete({
      model: 'claude-haiku-4-5',
      messages: [
        { role: 'system', content: 'You are Mo.' },
        { role: 'user', content: 'go' },
      ],
    });

    expect(calls[0]!.body.system).toBe('You are Mo.');
    expect(calls[0]!.body.messages).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('renames tool parameters → input_schema', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(
        JSON.stringify({
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: '' }],
          usage: { input_tokens: 5, output_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider('sk-ant-test');
    await provider.complete({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{
        name: 'notes_search',
        description: 'search',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      }],
    });

    const tools = calls[0]!.body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      name: 'notes_search',
      description: 'search',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    });
    // 'parameters' field MUST NOT leak through under the OpenAI name
    expect(tools[0]!.parameters).toBeUndefined();
  });

  it('parses tool_use blocks from response into flat toolCalls + concatenates text blocks', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          model: 'claude-haiku-4-5',
          content: [
            { type: 'text', text: "I'll look that up." },
            { type: 'tool_use', id: 'toolu_xyz', name: 'notes_search', input: { query: 'foo' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider('sk-ant-test');
    const resp = await provider.complete({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'find foo' }],
      tools: [{ name: 'notes_search', description: 's', parameters: { type: 'object' } }],
    });

    expect(resp.content).toBe("I'll look that up.");
    expect(resp.toolCalls).toEqual([{
      id: 'toolu_xyz',
      name: 'notes_search',
      // input is parsed object → must be re-stringified for engine compat
      argumentsJson: '{"query":"foo"}',
    }]);
  });

  it('costUsd computed from input_tokens + output_tokens via Anthropic pricing', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          content: [{ type: 'text', text: 'r' }],
          usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider('sk-ant-test');
    const resp = await provider.complete({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'x' }],
    });
    // Haiku 4.5: $1 input + $5 output per 1M
    expect(resp.costUsd).toBeCloseTo(1 + 5, 5);
    expect(resp.tokensIn).toBe(1_000_000);
    expect(resp.tokensOut).toBe(1_000_000);
  });

  it('ignores unknown content block types (extended thinking summaries, etc)', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          model: 'claude-opus-4-7',
          content: [
            { type: 'thinking', thinking: '<internal reasoning>' },
            { type: 'text', text: 'visible answer' },
            { type: 'redacted_thinking', data: 'opaque' },
          ],
          usage: { input_tokens: 50, output_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider('sk-ant-test');
    const resp = await provider.complete({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'x' }],
    });
    // Only the text block surfaces — thinking blocks are silently dropped
    expect(resp.content).toBe('visible answer');
  });

  it('non-2xx response surfaces status + body snippet', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new AnthropicProvider('sk-ant-test');
    await expect(
      provider.complete({ model: 'bogus', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/Anthropic 400/);
  });
});

describe('readProviderModel — anthropic backend', () => {
  let handle: DbHandle;
  let settings: SettingsRepository;

  beforeEach(() => {
    handle = openDb({ path: ':memory:' });
    settings = new SettingsRepository(handle.db);
  });

  afterEach(() => {
    handle.db.close();
  });

  it('empty key → Noop (matches groq/openrouter contract)', () => {
    settings.set('concierge.backend', 'anthropic');
    const host = makeHost(settings);
    const { provider } = readProviderModel(host);
    expect(provider).toBeInstanceOf(NoopLLMProvider);
  });

  it('valid sk-ant- key → real AnthropicProvider', () => {
    settings.set('concierge.backend', 'anthropic');
    settings.set('concierge.anthropic_api_key', 'sk-ant-test123');
    const host = makeHost(settings);
    const { provider } = readProviderModel(host);
    expect(provider.name).toBe('anthropic');
  });

  it('with no stored model → empty (no hardcoded default ships, 2026-04-26)', () => {
    settings.set('concierge.backend', 'anthropic');
    const host = makeHost(settings);
    const configured = readConfiguredProvider(host);
    // User picks the model on first config — vendor IDs change too
    // fast to ship a default. UI placeholder shows recommendations.
    expect(configured.model).toBe('');
  });

  it('respects stored model override', () => {
    settings.set('concierge.backend', 'anthropic');
    settings.set('concierge.anthropic_model', 'claude-opus-4-7');
    const host = makeHost(settings);
    const configured = readConfiguredProvider(host);
    expect(configured.model).toBe('claude-opus-4-7');
  });

  it('ANTHROPIC_API_KEY env fallback works', () => {
    settings.set('concierge.backend', 'anthropic');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env-test';
    try {
      const host = makeHost(settings);
      const configured = readConfiguredProvider(host);
      expect(configured.key).toBe('sk-ant-env-test');
      expect(configured.envConfigured).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('invalid stored key (wrong prefix) → falls back to Noop instead of throwing', () => {
    // The factory throws on bad prefix; readProviderModel catches and
    // returns Noop so a paste error doesn't crash the chat panel.
    settings.set('concierge.backend', 'anthropic');
    settings.set('concierge.anthropic_api_key', 'sk-test'); // openai-shaped, wrong vendor
    const host = makeHost(settings);
    const { provider } = readProviderModel(host);
    expect(provider).toBeInstanceOf(NoopLLMProvider);
  });
});

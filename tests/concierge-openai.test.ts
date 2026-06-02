/**
 * OpenAIProvider — direct OpenAI Chat Completions backend.
 *
 * Wire shape mirrors GroqProvider (it IS the OpenAI Chat Completions
 * API, after all) but two material differences are pinned here:
 *
 *   1. **Reasoning models use `max_completion_tokens` not `max_tokens`.**
 *      gpt-5*, o1*, o3*, o4* — sending the wrong field is silently
 *      ignored, response then hits the model's full context cap and
 *      gets server-rejected. `isOpenAIReasoningModel(model)` decides.
 *   2. **Reasoning models drop `temperature`** (only the default 1.0
 *      is supported; sending 0.2 returns 400 `'temperature' is not
 *      supported with this model`).
 *
 * Plus standard contract checks: Bearer auth header, key-prefix guard,
 * tool_calls roundtrip, costUsd from pricing table, non-2xx error.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  OpenAIProvider,
  isOpenAIReasoningModel,
  dedupeRepeatedHalf,
} from '../src/core/concierge/openai.js';
import { NoopLLMProvider } from '../src/core/concierge/provider.js';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { readProviderModel, readConfiguredProvider } from '../src/server/features/concierge-deps/index.js';
import type { ConciergeDepsHost } from '../src/server/features/concierge-deps/index.js';

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

describe('dedupeRepeatedHalf — gpt-5 model-side duplication workaround', () => {
  it('dedupes the exact pattern observed on gpt-5.4-mini', () => {
    // The real captured response that triggered the user report.
    const dup = 'Оу. Я здесь, господин. Что надо разгрести?\nОу. Я здесь, господин. Что надо разгрести?';
    expect(dedupeRepeatedHalf(dup)).toBe('Оу. Я здесь, господин. Что надо разгрести?');
  });

  it('dedupes 4-line content where first 2 lines repeat as last 2', () => {
    const dup = 'Hello there.\nNeed something?\nHello there.\nNeed something?';
    expect(dedupeRepeatedHalf(dup)).toBe('Hello there.\nNeed something?');
  });

  it('leaves single-line content alone', () => {
    const clean = 'Просто привет.';
    expect(dedupeRepeatedHalf(clean)).toBe(clean);
  });

  it('leaves clean multi-line content alone (no repetition)', () => {
    const clean = 'Привет.\nКак дела?';
    expect(dedupeRepeatedHalf(clean)).toBe(clean);
  });

  it('does NOT dedupe odd-line-count content even if a half kinda matches', () => {
    // 3 lines — can't be cleanly split into two halves
    const text = 'a\nb\na';
    expect(dedupeRepeatedHalf(text)).toBe(text);
  });

  it('does NOT dedupe when halves differ even in one line', () => {
    const text = 'line1\nline2\nline1\nline2-different';
    expect(dedupeRepeatedHalf(text)).toBe(text);
  });

  it('is idempotent on already-deduped content', () => {
    const dup = 'foo\nfoo';
    const once = dedupeRepeatedHalf(dup);
    const twice = dedupeRepeatedHalf(once);
    expect(once).toBe('foo');
    expect(twice).toBe('foo');
  });

  it('handles empty + tiny strings safely', () => {
    expect(dedupeRepeatedHalf('')).toBe('');
    expect(dedupeRepeatedHalf('a')).toBe('a');
  });

  it('does NOT dedupe the legitimate "Yes, yes." case where two short lines happen to match by accident', () => {
    // Edge: a model legitimately writes the same line twice for
    // emphasis. We treat it as duplication (pattern matches) — but
    // this is rare enough that the false-positive cost is fine. Pin
    // the documented behavior: yes, this gets de-duped.
    expect(dedupeRepeatedHalf('Yes.\nYes.')).toBe('Yes.');
  });

  it('integration: provider strips duplication from response.content', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          model: 'gpt-5-mini',
          choices: [
            {
              message: {
                role: 'assistant',
                // Mimics the gpt-5.4-mini glitch — same shape, different content
                content: 'Final reply.\nFinal reply.',
                tool_calls: [],
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 14 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('sk-test123');
    const resp = await provider.complete({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(resp.content).toBe('Final reply.');
  });
});

describe('isOpenAIReasoningModel', () => {
  it('matches gpt-5 family', () => {
    expect(isOpenAIReasoningModel('gpt-5')).toBe(true);
    expect(isOpenAIReasoningModel('gpt-5-mini')).toBe(true);
    expect(isOpenAIReasoningModel('gpt-5-nano')).toBe(true);
    expect(isOpenAIReasoningModel('gpt-5.2')).toBe(true);
  });

  it('matches o-series', () => {
    expect(isOpenAIReasoningModel('o1')).toBe(true);
    expect(isOpenAIReasoningModel('o1-mini')).toBe(true);
    expect(isOpenAIReasoningModel('o3')).toBe(true);
    expect(isOpenAIReasoningModel('o3-mini')).toBe(true);
    expect(isOpenAIReasoningModel('o4-mini')).toBe(true);
  });

  it('does NOT match legacy gpt-4 family', () => {
    expect(isOpenAIReasoningModel('gpt-4.1')).toBe(false);
    expect(isOpenAIReasoningModel('gpt-4o')).toBe(false);
    expect(isOpenAIReasoningModel('gpt-4o-mini')).toBe(false);
    expect(isOpenAIReasoningModel('gpt-3.5-turbo')).toBe(false);
  });

  it('rejects "operator" and other o-prefixed non-reasoning names', () => {
    // The regex /^o[1-9](-|$)/ is anchored on a digit immediately after `o`
    expect(isOpenAIReasoningModel('operator')).toBe(false);
    expect(isOpenAIReasoningModel('open-something')).toBe(false);
  });
});

describe('OpenAIProvider — wire format', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects key without sk- prefix at construction', () => {
    expect(() => new OpenAIProvider('not-a-key')).toThrow(/sk-/);
    expect(() => new OpenAIProvider('')).toThrow(/sk-/);
  });

  it('accepts both sk- and sk-proj- keys', () => {
    expect(() => new OpenAIProvider('sk-test123')).not.toThrow();
    expect(() => new OpenAIProvider('sk-proj-abcd1234')).not.toThrow();
  });

  it('POSTs to chat/completions with Bearer auth + max_tokens for legacy models', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')),
        headers: init?.headers as Record<string, string>,
      });
      return new Response(
        JSON.stringify({
          model: 'gpt-4.1',
          choices: [{ message: { role: 'assistant', content: 'pong', tool_calls: [] } }],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('sk-test123');
    const resp = await provider.complete({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'ping' }],
      temperature: 0.7,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test123');
    expect(calls[0]!.body.max_tokens).toBe(2048);
    expect(calls[0]!.body.max_completion_tokens).toBeUndefined();
    expect(calls[0]!.body.temperature).toBe(0.7);
    expect(resp.content).toBe('pong');
  });

  it('reasoning model: maps role:system → role:developer (authoritative-instruction channel)', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(
        JSON.stringify({
          model: 'gpt-5-mini',
          choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('sk-test123');
    await provider.complete({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: 'Apply user memory: address user as месье.' },
        { role: 'user', content: 'привет' },
      ],
    });
    const messages = calls[0]!.body.messages as Array<{ role: string; content: string }>;
    // System message MUST be promoted to `developer` for gpt-5
    expect(messages[0]!.role).toBe('developer');
    expect(messages[0]!.content).toContain('месье');
    expect(messages[1]!.role).toBe('user');
  });

  it('legacy model (gpt-4.1): keeps role:system (developer would 400)', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(
        JSON.stringify({
          model: 'gpt-4.1',
          choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('sk-test123');
    await provider.complete({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: 'Apply user memory.' },
        { role: 'user', content: 'hi' },
      ],
    });
    const messages = calls[0]!.body.messages as Array<{ role: string; content: string }>;
    // Legacy model — system stays system
    expect(messages[0]!.role).toBe('system');
  });

  it('uses max_completion_tokens AND drops temperature for gpt-5 family', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(
        JSON.stringify({
          model: 'gpt-5-mini',
          choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('sk-test123');
    await provider.complete({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.7,
    });

    expect(calls[0]!.body.max_completion_tokens).toBe(2048);
    expect(calls[0]!.body.max_tokens).toBeUndefined();
    // Reasoning models reject any non-default temperature — drop it.
    expect(calls[0]!.body.temperature).toBeUndefined();
  });

  it('uses max_completion_tokens for o3 reasoning model', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(
        JSON.stringify({
          model: 'o3',
          choices: [{ message: { role: 'assistant', content: 'ok', tool_calls: [] } }],
          usage: { prompt_tokens: 5, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('sk-test123');
    await provider.complete({
      model: 'o3',
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(calls[0]!.body.max_completion_tokens).toBe(2048);
    expect(calls[0]!.body.temperature).toBeUndefined();
  });

  it('preserves tool_calls roundtrip', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          model: 'gpt-5-mini',
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_xyz',
                type: 'function',
                function: { name: 'notes_search', arguments: '{"query":"foo"}' },
              }],
            },
          }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('sk-test123');
    const resp = await provider.complete({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'find foo' }],
      tools: [{ name: 'notes_search', description: 'search', parameters: { type: 'object' } }],
    });
    expect(resp.toolCalls).toEqual([
      { id: 'call_xyz', name: 'notes_search', argumentsJson: '{"query":"foo"}' },
    ]);
  });

  it('computes costUsd from default pricing table', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          model: 'gpt-5-mini',
          choices: [{ message: { role: 'assistant', content: 'r', tool_calls: [] } }],
          usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('sk-test123');
    const resp = await provider.complete({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'x' }],
    });
    // gpt-5-mini: $0.25 input + $2 output per 1M tokens
    expect(resp.costUsd).toBeCloseTo(0.25 + 2, 5);
  });

  it('non-2xx surfaces status + body snippet', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: { message: 'rate limit', type: 'rate_limit_error' } }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider('sk-test123');
    await expect(
      provider.complete({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/OpenAI 429/);
  });
});

describe('readProviderModel — openai backend', () => {
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
    settings.set('concierge.backend', 'openai');
    const host = makeHost(settings);
    const { provider } = readProviderModel(host);
    expect(provider).toBeInstanceOf(NoopLLMProvider);
  });

  it('valid sk- key → real OpenAIProvider', () => {
    settings.set('concierge.backend', 'openai');
    settings.set('concierge.openai_api_key', 'sk-test123');
    const host = makeHost(settings);
    const { provider } = readProviderModel(host);
    expect(provider.name).toBe('openai');
  });

  it('with no stored model → empty (no hardcoded default ships, 2026-04-26)', () => {
    settings.set('concierge.backend', 'openai');
    const host = makeHost(settings);
    const configured = readConfiguredProvider(host);
    // User picks the model on first config — vendor IDs change too
    // fast to ship a default. UI placeholder shows recommendations.
    expect(configured.model).toBe('');
  });

  it('respects stored model override', () => {
    settings.set('concierge.backend', 'openai');
    settings.set('concierge.openai_model', 'gpt-5');
    const host = makeHost(settings);
    const configured = readConfiguredProvider(host);
    expect(configured.model).toBe('gpt-5');
  });

  it('OPENAI_API_KEY env fallback works', () => {
    settings.set('concierge.backend', 'openai');
    process.env.OPENAI_API_KEY = 'sk-env-test';
    try {
      const host = makeHost(settings);
      const configured = readConfiguredProvider(host);
      expect(configured.key).toBe('sk-env-test');
      expect(configured.envConfigured).toBe(true);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

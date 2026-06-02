/**
 * OllamaProvider — local-first Mo backend.
 *
 * Wire-format mirror of GroqProvider / OpenRouterProvider (OpenAI-
 * compatible POST to `${baseUrl}/v1/chat/completions`) but with three
 * material differences pinned by these tests:
 *   1. NO Authorization header (no API key for local inference).
 *   2. costUsd ALWAYS 0 (running on user's hardware).
 *   3. Tool-call roundtrip is intact (assistant emits tool_calls →
 *      next user-side message can be a `role='tool'` reply paired by
 *      tool_call_id).
 *
 * Plus provider-routing tests for `readProviderModel` so the empty-key
 * fallback to NoopLLMProvider DOESN'T fire for ollama (empty just means
 * "use default localhost"). For groq/openrouter empty key still falls
 * to Noop — that contract is unchanged.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { OllamaProvider, DEFAULT_OLLAMA_BASE_URL } from '../src/core/concierge/ollama.js';
import { NoopLLMProvider } from '../src/core/concierge/provider.js';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { readProviderModel, readConfiguredProvider } from '../src/server/features/concierge-deps/index.js';
import type { ConciergeDepsHost } from '../src/server/features/concierge-deps/index.js';

// Minimal host stub for the routing tests — only `settings` and the
// `concierge` bag's `providerOverride` slot are read by the helpers
// under test, so we can leave the rest as `any`.
function makeHost(settings: SettingsRepository): ConciergeDepsHost {
  return {
    db: undefined as unknown as Database.Database,
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

describe('OllamaProvider — wire format', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs to ${baseUrl}/v1/chat/completions with NO Authorization header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          model: 'qwen2.5:14b-instruct',
          choices: [
            {
              message: { role: 'assistant', content: 'pong', tool_calls: [] },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' });
    const resp = await provider.complete({
      model: 'qwen2.5:14b-instruct',
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    // No Authorization header — local inference, no key.
    expect(headers.authorization).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
    expect(resp.content).toBe('pong');
    expect(resp.model).toBe('qwen2.5:14b-instruct');
  });

  it('strips trailing slashes from baseUrl', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          model: 'm',
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [] } }],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434///' });
    await provider.complete({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(calls[0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('defaults baseUrl to http://localhost:11434 when not given', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          model: 'm',
          choices: [{ message: { role: 'assistant', content: '', tool_calls: [] } }],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider();
    await provider.complete({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(calls[0]).toBe(`${DEFAULT_OLLAMA_BASE_URL}/v1/chat/completions`);
  });

  it('costUsd is ALWAYS 0 even with non-zero token counts', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          model: 'qwen2.5:14b-instruct',
          choices: [
            {
              message: { role: 'assistant', content: 'long reply', tool_calls: [] },
            },
          ],
          usage: { prompt_tokens: 5000, completion_tokens: 2000 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' });
    const resp = await provider.complete({
      model: 'qwen2.5:14b-instruct',
      messages: [{ role: 'user', content: 'big' }],
    });
    // Local inference — never billed regardless of token count.
    expect(resp.costUsd).toBe(0);
    expect(resp.tokensIn).toBe(5000);
    expect(resp.tokensOut).toBe(2000);
  });

  it('tool_calls roundtrip is preserved (id + name + argumentsJson)', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          model: 'qwen2.5:14b-instruct',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_abc123',
                    type: 'function',
                    function: {
                      name: 'notes_search',
                      arguments: '{"query":"foo"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' });
    const resp = await provider.complete({
      model: 'qwen2.5:14b-instruct',
      messages: [{ role: 'user', content: 'find foo' }],
      tools: [
        {
          name: 'notes_search',
          description: 'search notes',
          parameters: { type: 'object' },
        },
      ],
    });
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls[0]).toEqual({
      id: 'call_abc123',
      name: 'notes_search',
      argumentsJson: '{"query":"foo"}',
    });
  });

  it('non-2xx response surfaces status + body snippet in error', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('model not found: bogus', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      });
    }) as unknown as typeof fetch;

    const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434' });
    await expect(
      provider.complete({
        model: 'bogus',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow(/Ollama 404/);
  });
});

describe('readProviderModel — ollama backend integration', () => {
  let handle: DbHandle;
  let settings: SettingsRepository;

  beforeEach(() => {
    handle = openDb({ path: ':memory:' });
    settings = new SettingsRepository(handle.db);
  });

  afterEach(() => {
    handle.db.close();
  });

  it('backend=ollama with no stored URL → real OllamaProvider, NOT noop', () => {
    settings.set('concierge.backend', 'ollama');
    const host = makeHost(settings);
    const { provider } = readProviderModel(host);
    // Empty stored URL is a VALID config for ollama (means "use
    // default localhost"). For groq/openrouter empty key would Noop.
    expect(provider.name).toBe('ollama');
    expect(provider).not.toBeInstanceOf(NoopLLMProvider);
  });

  it('backend=ollama uses stored base URL when set', () => {
    settings.set('concierge.backend', 'ollama');
    settings.set('concierge.ollama_base_url', 'http://192.168.1.50:11434');
    const host = makeHost(settings);
    const configured = readConfiguredProvider(host);
    expect(configured.backend).toBe('ollama');
    expect(configured.key).toBe('http://192.168.1.50:11434');
    expect(configured.storedKey).toBe('http://192.168.1.50:11434');
  });

  it('backend=ollama with no stored model → empty (no hardcoded default ships, 2026-04-26)', () => {
    settings.set('concierge.backend', 'ollama');
    const host = makeHost(settings);
    const configured = readConfiguredProvider(host);
    // User picks the model — vendor model ids change too fast to ship
    // an opinionated default. UI placeholder shows recommendations.
    expect(configured.model).toBe('');
  });

  it('backend=ollama respects stored model override', () => {
    settings.set('concierge.backend', 'ollama');
    settings.set('concierge.ollama_model', 'llama3.1:8b-instruct');
    const host = makeHost(settings);
    const configured = readConfiguredProvider(host);
    expect(configured.model).toBe('llama3.1:8b-instruct');
  });

  it('backend=groq with NO key → still falls back to Noop (contract unchanged)', () => {
    settings.set('concierge.backend', 'groq');
    const host = makeHost(settings);
    const { provider } = readProviderModel(host);
    expect(provider).toBeInstanceOf(NoopLLMProvider);
  });

  it('backend=openrouter with NO key → still falls back to Noop (contract unchanged)', () => {
    settings.set('concierge.backend', 'openrouter');
    const host = makeHost(settings);
    const { provider } = readProviderModel(host);
    expect(provider).toBeInstanceOf(NoopLLMProvider);
  });

  it('MORION_OLLAMA_BASE_URL env fallback works when no stored URL', () => {
    settings.set('concierge.backend', 'ollama');
    process.env.MORION_OLLAMA_BASE_URL = 'http://my-server:11434';
    try {
      const host = makeHost(settings);
      const configured = readConfiguredProvider(host);
      expect(configured.key).toBe('http://my-server:11434');
      expect(configured.envConfigured).toBe(true);
    } finally {
      delete process.env.MORION_OLLAMA_BASE_URL;
    }
  });
});

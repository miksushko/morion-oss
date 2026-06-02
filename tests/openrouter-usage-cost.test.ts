import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenRouterProvider } from '../src/core/concierge/openrouter.js';

/**
 * Regression for ticket 01KQVM1Z8SZ8WF89G005WCVWSH — production
 * `mo_spend_ledger` was silently empty because:
 *
 *  (a) The request body did not carry `usage: { include: true }`, so
 *      OpenRouter never populated the `usage.cost` field.
 *  (b) The response parser read a non-existent `usage.total_cost`
 *      field, so `costUsd` was always 0.
 *
 *  Both bugs together meant every OR call landed `costUsd: 0`, which
 *  `BudgetTracker.record()` filters out (`if (costUsd <= 0) return`),
 *  so the ledger never wrote a row and the monthly cap was never
 *  enforced. This pins the fix at the wire level — read both the
 *  outbound request body AND inbound response handling.
 */
describe('OpenRouterProvider — usage accounting (ticket 01KQVM1Z8SZ8WF89G005WCVWSH)', () => {
  let originalFetch: typeof globalThis.fetch;
  let lastBody: unknown = null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    lastBody = null;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(responseBody: unknown) {
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      const reqInit = (init ?? {}) as { body?: string };
      lastBody = JSON.parse(reqInit.body ?? '{}');
      return {
        ok: true,
        status: 200,
        json: async () => responseBody,
        text: async () => JSON.stringify(responseBody),
      } as unknown as Response;
    }) as typeof globalThis.fetch;
  }

  it('outbound body opts into usage accounting via `usage: {include: true}`', async () => {
    stubFetch({
      model: 'x-ai/grok-4.1-fast',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
    });

    const provider = new OpenRouterProvider('sk-or-test-key');
    await provider.complete({
      model: 'x-ai/grok-4.1-fast',
      messages: [{ role: 'user', content: 'hi' }],
    });

    const body = lastBody as Record<string, unknown>;
    expect(body.usage).toEqual({ include: true });
  });

  it('parses costUsd from `usage.cost` (NOT the legacy `total_cost`)', async () => {
    stubFetch({
      model: 'x-ai/grok-4.1-fast',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 350,
        cost: 0.00087,
      },
    });
    const provider = new OpenRouterProvider('sk-or-test-key');
    const resp = await provider.complete({
      model: 'x-ai/grok-4.1-fast',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(resp.costUsd).toBeCloseTo(0.00087, 6);
    expect(resp.tokensIn).toBe(1200);
    expect(resp.tokensOut).toBe(350);
  });

  it('parses cached + reasoning tokens from prompt_tokens_details / completion_tokens_details', async () => {
    stubFetch({
      model: 'deepseek/deepseek-v4-flash',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: {
        prompt_tokens: 5000,
        completion_tokens: 200,
        cost: 0.0021,
        prompt_tokens_details: {
          cached_tokens: 3200,
          cache_write_tokens: 0,
        },
        completion_tokens_details: {
          reasoning_tokens: 480,
        },
      },
    });
    const provider = new OpenRouterProvider('sk-or-test-key');
    const resp = await provider.complete({
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(resp.cachedTokens).toBe(3200);
    expect(resp.cacheWriteTokens).toBe(0);
    expect(resp.reasoningTokens).toBe(480);
    expect(resp.providerName).toBe('openrouter');
  });

  it('BYOK fallback: usage.cost=0 + is_byok=true → use upstream_inference_cost', async () => {
    stubFetch({
      model: 'anthropic/claude-sonnet-4',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        cost: 0,
        is_byok: true,
        cost_details: {
          upstream_inference_cost: 0.0124,
        },
      },
    });
    const provider = new OpenRouterProvider('sk-or-test-key');
    const resp = await provider.complete({
      model: 'anthropic/claude-sonnet-4',
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(resp.costUsd).toBeCloseTo(0.0124, 6);
  });

  it('graceful 0 when provider omits usage entirely (free-tier / error case)', async () => {
    stubFetch({
      model: 'meta-llama/llama-3.2-3b-instruct:free',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      // No `usage` block at all.
    });
    const provider = new OpenRouterProvider('sk-or-test-key');
    const resp = await provider.complete({
      model: 'meta-llama/llama-3.2-3b-instruct:free',
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(resp.costUsd).toBe(0);
    expect(resp.tokensIn).toBeNull();
    expect(resp.tokensOut).toBeNull();
    expect(resp.cachedTokens).toBeNull();
  });
});

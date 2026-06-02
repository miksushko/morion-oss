import { describe, it, expect, beforeEach } from 'vitest';
import { activatePro, json, setup, type Ctx } from './helpers/concierge-http-setup.js';

/**
 * HTTP /api/concierge/provider
 *
 * Extracted 2026-05-16 from tests/concierge-http.test.ts as part of the
 * oversized-file split (Morion ticket 01KRJZ050EX392K9NY7GAKA1JE).
 */

describe('HTTP /api/concierge/provider', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('stores Groq key/model under Groq-specific settings by default', async () => {
    activatePro(ctx.settings);
    const res = await ctx.app.request(
      '/api/concierge/provider',
      json({ apiKey: 'gsk_test', model: 'openai/gpt-oss-20b' }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      backend: string;
      hasApiKey: boolean;
      apiKeyHint: string;
      model: string;
    };
    expect(body.backend).toBe('groq');
    expect(body.hasApiKey).toBe(true);
    expect(body.apiKeyHint).toBe('…test');
    expect(body.model).toBe('openai/gpt-oss-20b');
    expect(ctx.settings.get('concierge.groq_api_key', '')).toBe('gsk_test');
    expect(ctx.settings.get('concierge.groq_model', '')).toBe('openai/gpt-oss-20b');
    expect(ctx.settings.get('concierge.openrouter_api_key', '')).toBe('');
  });

  it('does NOT bleed legacy concierge.model across backends (regression 2026-04-25)', async () => {
    // Pre-fix: server fell back from `concierge.{backend}_model` to a
    // single legacy `concierge.model` key (pre-V7 schema), so a value
    // saved while backend was openrouter would surface as the Groq
    // model when the user switched. Wrong vendor → Mo would 404 on the
    // first call. Codex finding 01KQ1H63C2CAKAGVHM0ZB231TP.
    //
    // Post-fix: only the per-backend setting is consulted. After
    // 2026-04-26 there's no hardcoded default either — empty stored
    // → empty model in the response. Legacy `concierge.model` rows
    // stay in the DB (data-preserve) but never reach the runtime.
    ctx.settings.set('concierge.model', 'llama-3.3-70b-versatile');
    const res = await ctx.app.request('/api/concierge/provider');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backend: string; model: string };
    expect(body.backend).toBe('groq');
    // Per-backend Groq slot is empty → server returns empty model,
    // NOT the legacy value above.
    expect(body.model).toBe('');
    // Legacy row preserved unchanged on disk so re-activating older
    // builds doesn't trip on a missing key.
    expect(ctx.settings.get('concierge.model', '')).toBe('llama-3.3-70b-versatile');
  });

  it('keeps OpenRouter key/model separate when backend is switched', async () => {
    activatePro(ctx.settings);
    const res = await ctx.app.request(
      '/api/concierge/provider',
      json(
        {
          backend: 'openrouter',
          apiKey: 'sk-or-v1-test',
          model: 'moonshotai/kimi-k2.5',
        },
        'PUT',
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backend: string; model: string };
    expect(body.backend).toBe('openrouter');
    expect(body.model).toBe('moonshotai/kimi-k2.5');
    expect(ctx.settings.get('concierge.backend', '')).toBe('openrouter');
    expect(ctx.settings.get('concierge.openrouter_api_key', '')).toBe('sk-or-v1-test');
    expect(ctx.settings.get('concierge.openrouter_model', '')).toBe('moonshotai/kimi-k2.5');
    expect(ctx.settings.get('concierge.groq_api_key', '')).toBe('');
  });
});

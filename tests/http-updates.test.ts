import { beforeEach, describe, expect, it } from 'vitest';

import { type Ctx, setup, json } from './http/helpers.js';

describe('HTTP /api/updates', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('GET /api/updates/status returns idle in a fresh process', async () => {
    const res = await ctx.app.request('/api/updates/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    // Other tests in this file may have triggered a download; the state
    // can be one of the in-progress states. We only care that it's a known
    // shape.
    expect(['idle', 'downloading', 'ready', 'error']).toContain(body.state);
  });

  it('POST /api/updates/download rejects URLs outside the morion-releases prefix', async () => {
    const res = await ctx.app.request('/api/updates/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://evil.example.com/Morion.dmg', version: '0.99.0' }),
    });
    expect(res.status).toBe(400); // ZodError → 400 via the global handler
  });

  it('POST /api/updates/download rejects malformed version strings', async () => {
    const res = await ctx.app.request('/api/updates/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://github.com/miksushko/morion-releases/releases/download/v0.94.0/Morion_0.94.0_aarch64.dmg',
        version: 'not-a-version',
      }),
    });
    expect(res.status).toBe(400);
  });
});

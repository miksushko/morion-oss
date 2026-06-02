import { beforeEach, describe, expect, it } from 'vitest';

import { type Ctx, setup, json } from './http/helpers.js';

describe('HTTP /api/settings + /api/settings/accept-terms (first-run consent)', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('GET /api/settings returns null acceptance on a fresh DB', async () => {
    const res = await ctx.app.request('/api/settings');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      terms: { current: string; acceptedAt: number | null; acceptedVersion: string | null };
    };
    expect(body.terms.acceptedAt).toBeNull();
    expect(body.terms.acceptedVersion).toBeNull();
    expect(body.terms.current).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('POST /api/settings/accept-terms persists acceptance and echoes it back', async () => {
    const initial = await ctx.app.request('/api/settings').then((r) => r.json() as Promise<{
      terms: { current: string };
    }>);
    const version = initial.terms.current;
    const res = await ctx.app.request(
      '/api/settings/accept-terms',
      json({ version }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: string;
      acceptedAt: number | null;
      acceptedVersion: string | null;
    };
    expect(body.acceptedVersion).toBe(version);
    expect(body.acceptedAt).toBeTypeOf('number');

    // Persistence round-trip through GET.
    const follow = await ctx.app.request('/api/settings');
    const followBody = (await follow.json()) as {
      terms: { acceptedAt: number | null; acceptedVersion: string | null };
    };
    expect(followBody.terms.acceptedVersion).toBe(version);
    expect(followBody.terms.acceptedAt).toBe(body.acceptedAt);
  });

  it('POST /api/settings/accept-terms rejects a mismatched version', async () => {
    const res = await ctx.app.request(
      '/api/settings/accept-terms',
      json({ version: '1999-01-01' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; expected: string };
    expect(body.error).toBe('terms_version_mismatch');
    expect(body.expected).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Nothing was persisted.
    const follow = await ctx.app.request('/api/settings');
    const followBody = (await follow.json()) as {
      terms: { acceptedVersion: string | null };
    };
    expect(followBody.terms.acceptedVersion).toBeNull();
  });
});

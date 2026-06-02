import { describe, it, expect, beforeEach } from 'vitest';
import {
  activatePro,
  setup,
  type Ctx,
} from '../helpers/concierge-http-setup.js';

/**
 * GET /api/auto-code/workflows — auth + query gates.
 * Pro-required + folderId-required preconditions.
 */
describe('HTTP /api/auto-code/workflows — seeding · gates', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx.settings);
  });

  it('GET requires folderId query', async () => {
    const res = await ctx.app.request('/api/auto-code/workflows');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('folderId_required');
  });
});

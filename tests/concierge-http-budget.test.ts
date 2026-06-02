import { describe, it, expect, beforeEach } from 'vitest';
import { activatePro, json, setup, type Ctx } from './helpers/concierge-http-setup.js';

/**
 * HTTP /api/concierge/budget
 *
 * Extracted 2026-05-16 from tests/concierge-http.test.ts as part of the
 * oversized-file split (Morion ticket 01KRJZ050EX392K9NY7GAKA1JE).
 */

describe('HTTP /api/concierge/budget', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns status even on Free', async () => {
    const res = await ctx.app.request('/api/concierge/budget');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      monthlyCapUsd: number;
      spentMonthUsd: number;
      withinBudget: boolean;
    };
    expect(body.monthlyCapUsd).toBe(10);
    expect(body.spentMonthUsd).toBe(0);
    expect(body.withinBudget).toBe(true);
  });
});

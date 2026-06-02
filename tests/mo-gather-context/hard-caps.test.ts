import { describe, it, expect, beforeEach } from 'vitest';
import {
  gatherContext,
  type GatherProgressEvent,
} from '../../src/core/concierge/index.js';
import {
  setup,
  GatherStubProvider,
  defaultResponder,
  type Ctx,
} from '../helpers/mo-gather-setup.js';

describe('gatherContext — hard caps', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('refuses pre-flight when remaining workspace budget < maxUsd', async () => {
    const provider = new GatherStubProvider(defaultResponder);
    // Burn all but $0.001 of the workspace budget.
    const status = ctx.budget.status();
    ctx.budget.record({
      kind: 'mo_tool',
      costUsd: status.monthlyCapUsd - 0.001,
    });

    const events: GatherProgressEvent[] = [];
    const packet = await gatherContext(
      { question: 'x' },
      {
        ctx: ctx.toolCtx,
        provider,
        subagentModel: 'stub',
        synthesisModel: 'stub',
        budget: ctx.budget,
        caps: { maxUsd: 0.05 },
        onProgress: (e) => events.push(e),
      },
    );
    expect(packet.capped).toBe('budget_exhausted');
    expect(packet.synthesizedMarkdown).toBe('');
    expect(packet.spentUsd).toBe(0);
    expect(events.find((e) => e.kind === 'capped')).toBeTruthy();
    // Provider should never have been called.
    expect(provider.calls).toHaveLength(0);
  });
});

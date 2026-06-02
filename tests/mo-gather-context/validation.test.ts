import { describe, it, expect, beforeEach } from 'vitest';
import { gatherContext } from '../../src/core/concierge/index.js';
import {
  setup,
  GatherStubProvider,
  defaultResponder,
  type Ctx,
} from '../helpers/mo-gather-setup.js';

describe('gatherContext — input validation', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('throws when neither taskId nor question is supplied', async () => {
    const provider = new GatherStubProvider(defaultResponder);
    await expect(
      gatherContext(
        {},
        {
          ctx: ctx.toolCtx,
          provider,
          subagentModel: 'stub',
          synthesisModel: 'stub',
          budget: ctx.budget,
        },
      ),
    ).rejects.toThrow(/exactly one/);
  });

  it('throws when both taskId and question are supplied', async () => {
    const provider = new GatherStubProvider(defaultResponder);
    await expect(
      gatherContext(
        { taskId: '01H', question: 'x' },
        {
          ctx: ctx.toolCtx,
          provider,
          subagentModel: 'stub',
          synthesisModel: 'stub',
          budget: ctx.budget,
        },
      ),
    ).rejects.toThrow(/exactly one/);
  });
});

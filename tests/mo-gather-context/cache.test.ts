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

describe('gatherContext — cache', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('exact-match cache hit on second identical call', async () => {
    const folder = ctx.folders.create('F');
    const task = ctx.notes.create(
      {
        body: '# Stripe idempotency long enough to clear the body length gate',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    ctx.meta.upsert({
      noteId: task.id,
      summary: 's',
      keywords: ['stripe'],
      computedBy: 'tier1',
    });

    const provider = new GatherStubProvider(defaultResponder);

    const first = await gatherContext(
      { taskId: task.id, folderId: folder.id },
      {
        ctx: ctx.toolCtx,
        provider,
        subagentModel: 'stub',
        synthesisModel: 'stub',
        budget: ctx.budget,
      },
    );
    expect(first.cacheHit).toBeNull();

    const callsAfterFirst = provider.calls.length;

    const events: GatherProgressEvent[] = [];
    const second = await gatherContext(
      { taskId: task.id, folderId: folder.id },
      {
        ctx: ctx.toolCtx,
        provider,
        subagentModel: 'stub',
        synthesisModel: 'stub',
        budget: ctx.budget,
        onProgress: (e) => events.push(e),
      },
    );
    expect(second.cacheHit).toEqual({ kind: 'exact' });
    expect(second.spentUsd).toBe(0);
    // Provider should NOT have been called again — full cache short-circuit.
    expect(provider.calls.length).toBe(callsAfterFirst);
    expect(events.find((e) => e.kind === 'cache_hit_exact')).toBeTruthy();
  });

  it('force: true bypasses the cache', async () => {
    const folder = ctx.folders.create('F');
    const task = ctx.notes.create(
      {
        body: '# Stripe idempotency body long enough to clear gate',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );

    const provider = new GatherStubProvider(defaultResponder);
    await gatherContext(
      { taskId: task.id, folderId: folder.id },
      {
        ctx: ctx.toolCtx,
        provider,
        subagentModel: 'stub',
        synthesisModel: 'stub',
        budget: ctx.budget,
      },
    );
    const callsAfterFirst = provider.calls.length;

    const second = await gatherContext(
      { taskId: task.id, folderId: folder.id, force: true },
      {
        ctx: ctx.toolCtx,
        provider,
        subagentModel: 'stub',
        synthesisModel: 'stub',
        budget: ctx.budget,
      },
    );
    expect(second.cacheHit).toBeNull();
    expect(provider.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

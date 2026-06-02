import { describe, it, expect, beforeEach } from 'vitest';
import {
  runMoIndexingTick,
  MO_INDEXING_AUDIT_CHECKPOINT_KEY,
} from '../../src/core/concierge/index.js';
import {
  buildDeps,
  longBody,
  setup,
  StubProvider,
  tier1Json,
  type Ctx,
} from '../helpers/mo-indexing-tick-setup.js';

describe('runMoIndexingTick — checkpoint contract', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('processes only audit rows newer than the stored checkpoint', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const a = ctx.notes.create(
      { body: longBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );
    void a;
    const provider = new StubProvider(tier1Json);

    // First tick — process A.
    const r1 = await runMoIndexingTick(
      buildDeps(ctx, {
        provider,
        tier1Model: 'm',
        tier1FallbackModel: null,
        tier2Model: "qwen/qwen3-235b-a22b-2507",
        tier2FallbackModel: null,
      }),
    );
    expect(r1.enqueued).toBe(1);
    const cpAfterFirst = ctx.workspaceSettings.get<number>(
      MO_INDEXING_AUDIT_CHECKPOINT_KEY,
      0,
    );
    expect(cpAfterFirst).toBeGreaterThan(0);

    // Add B → second tick should ONLY process B, not A.
    ctx.notes.create(
      { body: longBody('B'), folderId: folder.id, source: 'user' },
      'user',
    );
    const r2 = await runMoIndexingTick(
      buildDeps(ctx, {
        provider,
        tier1Model: 'm',
        tier1FallbackModel: null,
        tier2Model: "qwen/qwen3-235b-a22b-2507",
        tier2FallbackModel: null,
      }),
    );
    expect(r2.enqueued).toBe(1);
    const cpAfterSecond = ctx.workspaceSettings.get<number>(
      MO_INDEXING_AUDIT_CHECKPOINT_KEY,
      0,
    );
    expect(cpAfterSecond).toBeGreaterThan(cpAfterFirst);
  });
});

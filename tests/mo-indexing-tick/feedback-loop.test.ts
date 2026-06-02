import { describe, it, expect, beforeEach } from 'vitest';
import { runMoIndexingTick } from '../../src/core/concierge/index.js';
import {
  buildDeps,
  longBody,
  setup,
  StubProvider,
  tier1Json,
  type Ctx,
} from '../helpers/mo-indexing-tick-setup.js';

describe('runMoIndexingTick — feedback-loop guard', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('audit-actor filter skips morion-concierge writes on mo:* system notes', async () => {
    // Feedback-loop guard for the actual self-write hotspot:
    // morion-concierge appending to its own `mo:patrol-log` /
    // `mo:cluster:*` / `mo:catalog` notes. Two layers stack:
    //   - audit-actor filter (`a.actor != 'morion-concierge'`) skips
    //     audit rows from Mo's own writes.
    //   - source filter (`n.source NOT LIKE 'mo:%'`) on both step 1
    //     and the bootstrap sweep skips the note even if its audit
    //     row leaked through.
    // We verify the source filter here — the actor filter is
    // belt-and-braces below it.
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    ctx.notes.create(
      {
        body: '# Patrol log\n\n_Mo will append findings here._',
        folderId: folder.id,
        source: 'mo:patrol-log',
      },
      'morion-concierge',
    );

    const provider = new StubProvider(tier1Json);
    const summary = await runMoIndexingTick(
      buildDeps(ctx, {
        provider,
        tier1Model: 'm',
        tier1FallbackModel: null,
        tier2Model: "qwen/qwen3-235b-a22b-2507",
        tier2FallbackModel: null,
      }),
    );
    expect(summary.enqueued).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('still processes a separate user-actor edit on the same note', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const note = ctx.notes.create(
      { body: longBody('Mo'), folderId: folder.id, source: 'user' },
      'morion-concierge',
    );
    // Now a real user edits the same note → fresh audit row with actor=user.
    ctx.notes.update(note.id, { body: longBody('user-edit') }, 'user');

    const provider = new StubProvider(tier1Json);
    const summary = await runMoIndexingTick(
      buildDeps(ctx, {
        provider,
        tier1Model: 'm',
        tier1FallbackModel: null,
        tier2Model: "qwen/qwen3-235b-a22b-2507",
        tier2FallbackModel: null,
      }),
    );
    expect(summary.enqueued).toBe(1);
    expect(summary.worker?.computed).toBe(1);
  });
});

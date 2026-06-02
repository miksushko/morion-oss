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

describe('runMoIndexingTick — folder filter', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('skips notes in folders without Mo enabled', async () => {
    const enabled = ctx.folders.create('Enabled');
    const disabled = ctx.folders.create('Disabled');
    ctx.folderSettings.update(enabled.id, { enabled: true });
    // disabled folder: no concierge_folder_settings row at all (the
    // INNER JOIN on cfs filters it out automatically).

    ctx.notes.create(
      { body: longBody('In-enabled'), folderId: enabled.id, source: 'user' },
      'user',
    );
    ctx.notes.create(
      { body: longBody('In-disabled'), folderId: disabled.id, source: 'user' },
      'user',
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
    expect(summary.enqueued).toBe(1);
  });

  it('skips archived notes', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const note = ctx.notes.create(
      { body: longBody('archived'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.handle.db
      .prepare('UPDATE notes SET archived_at = ? WHERE id = ?')
      .run(Date.now(), note.id);

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
  });

  it('skips notes in archived folders', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    ctx.notes.create(
      { body: longBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.handle.db
      .prepare('UPDATE folders SET archived_at = ? WHERE id = ?')
      .run(Date.now(), folder.id);

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
  });
});

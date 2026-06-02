import { describe, it, expect, beforeEach } from 'vitest';
import {
  runMoIndexingTick,
  MO_INDEXING_AUDIT_CHECKPOINT_KEY,
} from '../../src/core/concierge/index.js';
import {
  buildDeps,
  longBody,
  setup,
  type Ctx,
} from '../helpers/mo-indexing-tick-setup.js';

describe('runMoIndexingTick — backend gate', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns gated_off when resolveProvider returns null', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    ctx.notes.create(
      { body: longBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );

    const summary = await runMoIndexingTick(buildDeps(ctx, null));
    expect(summary.status).toBe('gated_off');
    expect(summary.enqueued).toBe(0);
    expect(summary.worker).toBeNull();
    // Checkpoint stays at 0 — nothing processed.
    expect(
      ctx.workspaceSettings.get<number>(MO_INDEXING_AUDIT_CHECKPOINT_KEY, 0),
    ).toBe(0);
  });
});

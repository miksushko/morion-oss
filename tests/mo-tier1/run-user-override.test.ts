import { describe, it, expect, beforeEach } from 'vitest';
import { runTier1ForNote } from '../../src/core/concierge/index.js';
import {
  setupMoTier1Ctx,
  StubProvider,
  sampleBody,
  type MoTier1Ctx,
} from '../helpers/mo-tier1-setup.js';

describe('runTier1ForNote — user override preservation', () => {
  let ctx: MoTier1Ctx;
  beforeEach(() => {
    ctx = setupMoTier1Ctx();
  });

  it('replaceForNote keeps source=user assignments when Tier 1 reclassifies', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleBody, folderId: folder.id, source: 'user' },
      'user',
    );
    // User pinned a manual cluster before Tier 1 ever ran.
    ctx.clusters.upsert({
      noteId: note.id,
      clusterId: 'user-pinned',
      source: 'user',
    });

    const provider = new StubProvider({
      content: JSON.stringify({
        summary: 'tier1 view',
        keywords: ['k'],
        cluster_candidates: [{ cluster_id: 'tier1-pick', confidence: 0.9 }],
      }),
    });
    await runTier1ForNote(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider,
        model: 'm',
      },
      note.id,
    );

    const out = ctx.clusters.listForNote(note.id);
    expect(out.map((c) => c.clusterId).sort()).toEqual([
      'tier1-pick',
      'user-pinned',
    ]);
  });
});

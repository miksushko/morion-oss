import { describe, it, expect, beforeEach } from 'vitest';
import { hashBody, runTier1ForNote } from '../../src/core/concierge/index.js';
import {
  setupMoTier1Ctx,
  StubProvider,
  sampleBody,
  type MoTier1Ctx,
} from '../helpers/mo-tier1-setup.js';

describe('runTier1ForNote — body-hash short circuit', () => {
  let ctx: MoTier1Ctx;
  beforeEach(() => {
    ctx = setupMoTier1Ctx();
  });

  it('returns fresh / hash_match when cache is hot and skips the LLM call', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleBody, folderId: folder.id, source: 'user' },
      'user',
    );
    const hash = hashBody(sampleBody);
    ctx.meta.upsert({
      noteId: note.id,
      summary: 'cached summary',
      keywords: ['cached'],
      bodyHash: hash,
      computedBy: 'tier1',
      computedAt: 1000,
      confidence: 0.8,
    });
    const provider = new StubProvider({
      content: '{"summary": "should not be called"}',
    });
    const result = await runTier1ForNote(
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
    expect(result.status).toBe('fresh');
    if (result.status !== 'fresh') return;
    expect(result.reason).toBe('hash_match');
    expect(provider.calls).toHaveLength(0);
  });

  it('force=true bypasses the hash short-circuit', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleBody, folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: note.id,
      summary: 'cached',
      bodyHash: hashBody(sampleBody),
      computedBy: 'tier1',
      computedAt: 0,
    });
    const provider = new StubProvider({
      content: JSON.stringify({
        summary: 'forced',
        keywords: [],
        cluster_candidates: [],
      }),
    });
    const result = await runTier1ForNote(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider,
        model: 'm',
      },
      note.id,
      { force: true },
    );
    expect(result.status).toBe('computed');
    expect(provider.calls).toHaveLength(1);
  });
});

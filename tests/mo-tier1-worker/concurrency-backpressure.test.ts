import { describe, it, expect, beforeEach } from 'vitest';
import { drainTier1Queue, hashBody } from '../../src/core/concierge/index.js';
import {
  StubProvider,
  longBody,
  okResponse,
  setupMoTier1WorkerCtx,
  type MoTier1WorkerCtx,
} from '../helpers/mo-tier1-worker-setup.js';

describe('drainTier1Queue — concurrency cap', () => {
  let ctx: MoTier1WorkerCtx;
  beforeEach(() => {
    ctx = setupMoTier1WorkerCtx();
  });

  it('never exceeds the concurrency cap in flight', async () => {
    const folder = ctx.folders.create('F');
    // 10 notes, cap = 3 → maxConcurrent must be ≤ 3.
    const noteIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const tag = `T${i}`;
      const note = ctx.notes.create(
        { body: longBody(tag), folderId: folder.id, source: 'user' },
        'user',
      );
      noteIds.push(note.id);
      ctx.metadataQueue.enqueue(folder.id, note.id, 'tier1', hashBody(longBody(tag)));
    }
    const provider = new StubProvider(async (r) => {
      // Hold the call open briefly so concurrent calls actually overlap.
      await new Promise((res) => setTimeout(res, 15));
      return okResponse(r.model);
    });
    const summary = await drainTier1Queue(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        metadataQueue: ctx.metadataQueue,
        clusterQueue: ctx.clusterQueue,
        provider,
        model: 'm',
      },
      { concurrency: 3 },
    );
    expect(summary.computed).toBe(10);
    expect(provider.maxConcurrent).toBeGreaterThan(1);
    expect(provider.maxConcurrent).toBeLessThanOrEqual(3);
  });
});

describe('drainTier1Queue — body-hash idempotency', () => {
  let ctx: MoTier1WorkerCtx;
  beforeEach(() => {
    ctx = setupMoTier1WorkerCtx();
  });

  it('completes stale work-items (current body diverges from queued hash) without calling the LLM', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: longBody('orig'), folderId: folder.id, source: 'user' },
      'user',
    );
    // Enqueue with the original hash.
    ctx.metadataQueue.enqueue(
      folder.id,
      note.id,
      'tier1',
      hashBody(longBody('orig')),
    );
    // Then the user / agent edits the note → body diverges from the queue's body_hash.
    ctx.notes.update(note.id, { body: longBody('edited') }, 'user');

    const provider = new StubProvider(async (r) => okResponse(r.model));
    const summary = await drainTier1Queue({
      db: ctx.handle.db,
      notes: ctx.notes,
      metaRepo: ctx.meta,
      clustersRepo: ctx.clusters,
      metadataQueue: ctx.metadataQueue,
      clusterQueue: ctx.clusterQueue,
      provider,
      model: 'm',
    });
    expect(summary.fresh).toBe(1);
    expect(summary.computed).toBe(0);
    expect(provider.calls).toHaveLength(0);
    // The stale work-item is gone — caller will re-enqueue with the
    // updated body hash via note_changed event subscriber (Phase 2c).
    expect(ctx.metadataQueue.listForFolder(folder.id)).toHaveLength(0);
  });
});

describe('drainTier1Queue — back-pressure bounds', () => {
  let ctx: MoTier1WorkerCtx;
  beforeEach(() => {
    ctx = setupMoTier1WorkerCtx();
  });

  it('respects maxItems and stops draining when reached', async () => {
    const folder = ctx.folders.create('F');
    for (let i = 0; i < 12; i++) {
      const tag = `T${i}`;
      const note = ctx.notes.create(
        { body: longBody(tag), folderId: folder.id, source: 'user' },
        'user',
      );
      ctx.metadataQueue.enqueue(folder.id, note.id, 'tier1', hashBody(longBody(tag)));
    }
    const provider = new StubProvider(async (r) => okResponse(r.model));
    const summary = await drainTier1Queue(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        metadataQueue: ctx.metadataQueue,
        clusterQueue: ctx.clusterQueue,
        provider,
        model: 'm',
      },
      { maxItems: 5, concurrency: 2 },
    );
    expect(summary.claimed).toBe(5);
    // Remaining 7 still queued for the next drain call.
    expect(ctx.metadataQueue.listForFolder(folder.id)).toHaveLength(7);
  });
});

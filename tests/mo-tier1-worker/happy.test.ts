import { describe, it, expect, beforeEach } from 'vitest';
import { drainTier1Queue, hashBody } from '../../src/core/concierge/index.js';
import {
  StubProvider,
  longBody,
  okResponse,
  setupMoTier1WorkerCtx,
  type MoTier1WorkerCtx,
} from '../helpers/mo-tier1-worker-setup.js';

describe('drainTier1Queue — happy path', () => {
  let ctx: MoTier1WorkerCtx;
  beforeEach(() => {
    ctx = setupMoTier1WorkerCtx();
  });

  it('claims, runs Tier 1, completes, and reports a summary', async () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create(
      { body: longBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );
    const b = ctx.notes.create(
      { body: longBody('B'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.metadataQueue.enqueue(folder.id, a.id, 'tier1', hashBody(longBody('A')));
    ctx.metadataQueue.enqueue(folder.id, b.id, 'tier1', hashBody(longBody('B')));

    const provider = new StubProvider(async (r) => okResponse(r.model));
    const summary = await drainTier1Queue({
      db: ctx.handle.db,
      notes: ctx.notes,
      metaRepo: ctx.meta,
      clustersRepo: ctx.clusters,
      metadataQueue: ctx.metadataQueue,
      clusterQueue: ctx.clusterQueue,
      provider,
      budget: ctx.budget,
      model: 'mistralai/mistral-nemo',
    });

    expect(summary.claimed).toBe(2);
    expect(summary.computed).toBe(2);
    expect(summary.fresh).toBe(0);
    expect(summary.errors).toBe(0);
    expect(summary.abandoned).toBe(0);
    expect(ctx.metadataQueue.listForFolder(folder.id)).toHaveLength(0);
    // Both notes have metadata + clusters now.
    expect(ctx.meta.get(a.id)).not.toBeNull();
    expect(ctx.meta.get(b.id)).not.toBeNull();
    expect(ctx.clusters.listForNote(a.id).map((c) => c.clusterId).sort()).toEqual([
      'cluster-x',
      'cluster-y',
    ]);
  });

  it('marks each touched cluster dirty in mo_cluster_queue (deduped)', async () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create(
      { body: longBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );
    const b = ctx.notes.create(
      { body: longBody('B'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.metadataQueue.enqueue(folder.id, a.id, 'tier1', hashBody(longBody('A')));
    ctx.metadataQueue.enqueue(folder.id, b.id, 'tier1', hashBody(longBody('B')));

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

    expect(summary.dirtyClusters.sort()).toEqual(['cluster-x', 'cluster-y']);
    const queued = ctx.clusterQueue.listForFolder(folder.id);
    // Two clusters, NOT four (dedup across notes).
    expect(queued.map((q) => q.clusterId).sort()).toEqual(['cluster-x', 'cluster-y']);
  });
});

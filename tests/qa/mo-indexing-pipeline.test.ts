import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runMoIndexingTick,
  hashBody,
  ensurePatrolLogNote,
  appendFindings,
  runTier0Checks,
  drainTier1Queue,
  MO_INDEXING_AUDIT_CHECKPOINT_KEY,
  MO_INDEXING_TIER1_MODEL,
  MO_INDEXING_TIER1_FALLBACK,
  CONCIERGE_ACTOR as MO_ACTOR,
} from '../../src/core/concierge/index.js';
import {
  buildIndexingDeps,
  defaultProvider,
  longBody,
  setupQa,
  StubProvider,
  tier1Json,
  type QaCtx,
  type StubResponseSpec,
} from '../helpers/mo-indexing-setup.js';

/**
 * QA — Mo Indexing pipeline — Tier 1 metadata + cluster queue output + edit/idempotency/budget cycle.
 *
 * Extracted 2026-05-16 from tests/qa/mo-indexing-phase1-2.test.ts
 * (Morion ticket 01KRJZ3Q7W0KREH04R0WK5V6F9, second pass).
 */

describe('QA — Mo Indexing pipeline (happy path / idempotency / edit cycle / clusters / budget)', () => {
  let qa: QaCtx;

  beforeEach(() => {
    qa = setupQa();
  });

  afterEach(() => {
    qa.cleanup();
  });

  it('Case 3: Happy path — edit → tick → metadata + clusters + queue', async () => {
    const folder = qa.rt.folders.create('Happy');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const note = qa.rt.notes.create(
      { body: longBody('happy'), folderId: folder.id, source: 'user' },
      'user',
    );

    const stub = new StubProvider(() => ({ content: tier1Json }));
    const summary = await runMoIndexingTick(
      buildIndexingDeps(qa.rt, () => defaultProvider(stub)),
    );
    expect(summary.status).toBe('ok');
    expect(summary.enqueued).toBe(1);
    expect(summary.worker?.computed).toBe(1);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.model).toBe(MO_INDEXING_TIER1_MODEL);

    const meta = qa.rt.concierge.moMetadata.get(note.id);
    expect(meta?.summary).toContain('QA-driven note');
    expect(meta?.bodyHash).toBe(hashBody(longBody('happy')));
    expect(meta?.computedBy).toBe('tier1');

    const clusters = qa.rt.concierge.moClusters.listForNote(note.id);
    expect(clusters.map((c) => c.clusterId).sort()).toEqual([
      'mo-tier1',
      'qa-pipeline',
    ]);

    const dirty = qa.rt.concierge.moClusterQueue.listForFolder(folder.id);
    expect(dirty.map((d) => d.clusterId).sort()).toEqual([
      'mo-tier1',
      'qa-pipeline',
    ]);

    expect(qa.rt.settings.get(MO_INDEXING_AUDIT_CHECKPOINT_KEY, 0)).toBeGreaterThan(0);
  });

  it('Case 4: Idempotency — second tick with no changes → no_work', async () => {
    const folder = qa.rt.folders.create('Idem');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    qa.rt.notes.create(
      { body: longBody('idem'), folderId: folder.id, source: 'user' },
      'user',
    );
    const stub = new StubProvider(() => ({ content: tier1Json }));
    const deps = buildIndexingDeps(qa.rt, () => defaultProvider(stub));

    await runMoIndexingTick(deps);
    expect(stub.calls).toHaveLength(1);
    const summary = await runMoIndexingTick(deps);
    expect(summary.status).toBe('no_work');
    expect(stub.calls).toHaveLength(1); // unchanged
  });

  it('Case 5: Body-hash short-circuit on manual re-enqueue', async () => {
    const folder = qa.rt.folders.create('Hash');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const note = qa.rt.notes.create(
      { body: longBody('hash'), folderId: folder.id, source: 'user' },
      'user',
    );
    // Pre-cache metadata with the current hash.
    qa.rt.concierge.moMetadata.upsert({
      noteId: note.id,
      summary: 'cached summary',
      keywords: ['cached'],
      bodyHash: hashBody(longBody('hash')),
      computedBy: 'tier1',
      computedAt: 1,
      confidence: 0.9,
    });
    qa.rt.concierge.moMetadataQueue.enqueue(
      folder.id,
      note.id,
      'tier1',
      hashBody(longBody('hash')),
    );

    const stub = new StubProvider(() => ({ content: tier1Json }));
    const summary = await drainTier1Queue({
      db: qa.rt.handle.db,
      notes: qa.rt.notes,
      metaRepo: qa.rt.concierge.moMetadata,
      clustersRepo: qa.rt.concierge.moClusters,
      metadataQueue: qa.rt.concierge.moMetadataQueue,
      clusterQueue: qa.rt.concierge.moClusterQueue,
      provider: stub,
      budget: qa.rt.concierge.budget,
      model: MO_INDEXING_TIER1_MODEL,
    });
    expect(summary.fresh).toBe(1);
    expect(summary.computed).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it('Case 6: Edit triggers re-process', async () => {
    const folder = qa.rt.folders.create('Edit');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const note = qa.rt.notes.create(
      { body: longBody('v1'), folderId: folder.id, source: 'user' },
      'user',
    );
    const stub = new StubProvider(() => ({ content: tier1Json }));
    const deps = buildIndexingDeps(qa.rt, () => defaultProvider(stub));

    // First pass — initial classification.
    await runMoIndexingTick(deps);
    expect(stub.calls).toHaveLength(1);
    // Edit body — produces a fresh audit row + new body_hash.
    qa.rt.notes.update(note.id, { body: longBody('v2-edited') }, 'user');
    const summary = await runMoIndexingTick(deps);
    expect(summary.enqueued).toBe(1);
    expect(summary.worker?.computed).toBe(1);
    expect(stub.calls).toHaveLength(2);

    const meta = qa.rt.concierge.moMetadata.get(note.id);
    expect(meta?.bodyHash).toBe(hashBody(longBody('v2-edited')));
  });


  it('Case 12: User-pinned cluster preserved across re-classification', async () => {
    const folder = qa.rt.folders.create('Pinned');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const note = qa.rt.notes.create(
      { body: longBody('pinned'), folderId: folder.id, source: 'user' },
      'user',
    );
    qa.rt.concierge.moClusters.upsert({
      noteId: note.id,
      clusterId: 'pinned-by-user',
      source: 'user',
    });
    const stub = new StubProvider(() => ({ content: tier1Json }));
    await runMoIndexingTick(
      buildIndexingDeps(qa.rt, () => defaultProvider(stub)),
    );
    const clusters = qa.rt.concierge.moClusters
      .listForNote(note.id)
      .map((c) => c.clusterId)
      .sort();
    expect(clusters).toContain('pinned-by-user');
    expect(clusters).toContain('mo-tier1');
    expect(clusters).toContain('qa-pipeline');
  });

  it('Case 13: Cluster queue feeds Phase 3', async () => {
    const folder = qa.rt.folders.create('ClusterQueue');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    qa.rt.notes.create(
      { body: longBody('cq'), folderId: folder.id, source: 'user' },
      'user',
    );
    const stub = new StubProvider(() => ({ content: tier1Json }));
    await runMoIndexingTick(
      buildIndexingDeps(qa.rt, () => defaultProvider(stub)),
    );
    const queued = qa.rt.concierge.moClusterQueue.listForFolder(folder.id);
    // Both cluster ids present, picked_at NULL, dirty_since recorded.
    expect(queued).toHaveLength(2);
    for (const row of queued) {
      expect(row.pickedAt).toBeNull();
      expect(row.dirtySince).toBeGreaterThan(0);
    }
  });

  it('Case 14: Bulk burst — 10 notes back-to-back, all processed in one tick', async () => {
    const folder = qa.rt.folders.create('Bulk');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const n = qa.rt.notes.create(
        { body: longBody(`b${i}`), folderId: folder.id, source: 'user' },
        'user',
      );
      ids.push(n.id);
    }
    const stub = new StubProvider(() => ({ content: tier1Json }));
    const summary = await runMoIndexingTick(
      buildIndexingDeps(qa.rt, () => defaultProvider(stub)),
    );
    expect(summary.enqueued).toBe(10);
    expect(summary.worker?.computed).toBe(10);
    for (const id of ids) {
      expect(qa.rt.concierge.moMetadata.get(id)).not.toBeNull();
    }
  });


  it('Case 17: Budget exhausted → tick abandons, no metadata', async () => {
    const folder = qa.rt.folders.create('Budget');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const note = qa.rt.notes.create(
      { body: longBody('budget'), folderId: folder.id, source: 'user' },
      'user',
    );
    qa.rt.concierge.moSpendLedger.record({ kind: 'mo_tool', costUsd: 11 });

    const stub = new StubProvider(() => ({ content: tier1Json }));
    const summary = await runMoIndexingTick(
      buildIndexingDeps(qa.rt, () => defaultProvider(stub)),
    );
    expect(summary.enqueued).toBe(1);
    expect(summary.worker?.abandoned).toBe(1);
    expect(summary.worker?.abandonedItems[0]?.reason).toBe('budget_exceeded');
    expect(qa.rt.concierge.moMetadata.get(note.id)).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });

});

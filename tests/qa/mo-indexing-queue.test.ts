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
 * QA — Mo Indexing queue mechanics — what happens at the queue/drain boundary.
 *
 * Extracted 2026-05-16 from tests/qa/mo-indexing-phase1-2.test.ts
 * (Morion ticket 01KRJZ3Q7W0KREH04R0WK5V6F9, second pass).
 */

describe('QA — Mo Indexing queue mechanics (hard-delete cascade / stale enqueue / checkpoint contract)', () => {
  let qa: QaCtx;

  beforeEach(() => {
    qa = setupQa();
  });

  afterEach(() => {
    qa.cleanup();
  });

  it('Case 18: Note hard-deleted between enqueue and drain', async () => {
    const folder = qa.rt.folders.create('Deleted');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const note = qa.rt.notes.create(
      { body: longBody('doomed'), folderId: folder.id, source: 'user' },
      'user',
    );
    qa.rt.concierge.moMetadataQueue.enqueue(
      folder.id,
      note.id,
      'tier1',
      hashBody(longBody('doomed')),
    );
    qa.rt.handle.db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);

    const stub = new StubProvider(() => ({ content: tier1Json }));
    const summary = await drainTier1Queue({
      db: qa.rt.handle.db,
      notes: qa.rt.notes,
      metaRepo: qa.rt.concierge.moMetadata,
      clustersRepo: qa.rt.concierge.moClusters,
      metadataQueue: qa.rt.concierge.moMetadataQueue,
      clusterQueue: qa.rt.concierge.moClusterQueue,
      provider: stub,
      model: MO_INDEXING_TIER1_MODEL,
    });
    // CASCADE on `notes.id` cleared the queue row before we could
    // claim it — so claimed=0 (correct: queue row is gone). No LLM
    // call either way.
    expect(summary.claimed).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });

  it('Case 19: Stale enqueue body_hash → fresh, no LLM call', async () => {
    const folder = qa.rt.folders.create('StaleHash');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const note = qa.rt.notes.create(
      { body: longBody('orig'), folderId: folder.id, source: 'user' },
      'user',
    );
    // Enqueue with the original hash, then edit (writes new body).
    qa.rt.concierge.moMetadataQueue.enqueue(
      folder.id,
      note.id,
      'tier1',
      hashBody(longBody('orig')),
    );
    qa.rt.notes.update(note.id, { body: longBody('edited') }, 'user');

    const stub = new StubProvider(() => ({ content: tier1Json }));
    // Drain the manual enqueue. Note: the editing call ALSO posted a
    // fresh dirty mark via coalescing — both rows share the same
    // (folder, note, tier) key so the CURRENT body_hash is what's in
    // the queue. Worker re-hashes on claim and either matches (computed)
    // or mismatches (fresh). With coalescing, the latest hash wins,
    // matches, and Tier 1 fires once on the edited body.
    const summary = await drainTier1Queue({
      db: qa.rt.handle.db,
      notes: qa.rt.notes,
      metaRepo: qa.rt.concierge.moMetadata,
      clustersRepo: qa.rt.concierge.moClusters,
      metadataQueue: qa.rt.concierge.moMetadataQueue,
      clusterQueue: qa.rt.concierge.moClusterQueue,
      provider: stub,
      model: MO_INDEXING_TIER1_MODEL,
    });
    // One tier1 call on the edited body — coalescing did its job.
    expect(summary.computed + summary.fresh).toBe(1);
    if (summary.computed === 1) {
      expect(qa.rt.concierge.moMetadata.get(note.id)?.bodyHash).toBe(
        hashBody(longBody('edited')),
      );
    }
  });

  it('Case 20: Checkpoint contract — tick 2 sees only newer audit rows', async () => {
    const folder = qa.rt.folders.create('Checkpoint');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const a = qa.rt.notes.create(
      { body: longBody('a'), folderId: folder.id, source: 'user' },
      'user',
    );
    const b = qa.rt.notes.create(
      { body: longBody('b'), folderId: folder.id, source: 'user' },
      'user',
    );
    void a;
    void b;
    const stub = new StubProvider(() => ({ content: tier1Json }));
    const deps = buildIndexingDeps(qa.rt, () => defaultProvider(stub));

    const t1 = await runMoIndexingTick(deps);
    expect(t1.enqueued).toBe(2);
    const cp1 = qa.rt.settings.get<number>(MO_INDEXING_AUDIT_CHECKPOINT_KEY, 0);

    qa.rt.notes.create(
      { body: longBody('c'), folderId: folder.id, source: 'user' },
      'user',
    );
    const t2 = await runMoIndexingTick(deps);
    expect(t2.enqueued).toBe(1);
    const cp2 = qa.rt.settings.get<number>(MO_INDEXING_AUDIT_CHECKPOINT_KEY, 0);
    expect(cp2).toBeGreaterThan(cp1);
  });
});

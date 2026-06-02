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
 * QA — Mo Indexing Phase 4 integration (Tier 2.5 mo:catalog)
 *
 * Extracted 2026-05-16 from tests/qa/mo-indexing-integration.test.ts
 * (Morion ticket 01KRJZ3Q7W0KREH04R0WK5V6F9). Drives the full
 * indexing pipeline against an on-disk SQLite DB wired through
 * buildRuntime — production path, LLM stubbed at the provider seam.
 */

describe('QA — Mo Indexing Phase 4 integration (Tier 2.5 mo:catalog)', () => {
  let qa: QaCtx;

  beforeEach(() => {
    qa = setupQa();
  });

  afterEach(() => {
    qa.cleanup();
  });

  it('Case 26: Multi-folder tick — Tier 2.5 fires once per folder with cluster activity', async () => {
    const folderA = qa.rt.folders.create('FolderA');
    const folderB = qa.rt.folders.create('FolderB');
    qa.rt.concierge.folderSettings.update(folderA.id, { enabled: true });
    qa.rt.concierge.folderSettings.update(folderB.id, { enabled: true });
    qa.rt.notes.create(
      { body: longBody('a1'), folderId: folderA.id, source: 'user' },
      'user',
    );
    qa.rt.notes.create(
      { body: longBody('b1'), folderId: folderB.id, source: 'user' },
      'user',
    );

    // tier1Json emits 2 cluster_candidates → 2 clusters per folder.
    // Tick 1: 2 Tier 1 calls (one per note).
    // Tick 2: 4 Tier 2 calls (2 clusters × 2 folders) + 2 Tier 2.5 (1 per folder).
    const tier2Body = [
      '<!-- mo:section-start id="overview" -->',
      'Cluster overview.',
      '<!-- mo:section-end id="overview" -->',
    ].join('\n');
    const catalogA = [
      '<!-- mo:section-start id="overview" -->',
      'Folder A catalog.',
      '<!-- mo:section-end id="overview" -->',
    ].join('\n');
    const catalogB = [
      '<!-- mo:section-start id="overview" -->',
      'Folder B catalog.',
      '<!-- mo:section-end id="overview" -->',
    ].join('\n');
    let callIdx = 0;
    const responses = [
      tier1Json, tier1Json,                       // 2x tier1
      tier2Body, tier2Body, tier2Body, tier2Body, // 4x tier2
      catalogA, catalogB,                         // 2x tier2.5
    ];
    const stub = new StubProvider(() => ({
      content: responses[callIdx++] ?? '',
    }));

    let nowVal = 1000;
    const deps = buildIndexingDeps(qa.rt, () => defaultProvider(stub));
    deps.now = () => nowVal;

    await runMoIndexingTick(deps);            // tick 1 — Tier 1 only
    nowVal = 70_000;
    const t2 = await runMoIndexingTick(deps); // tick 2 — Tier 2 + Tier 2.5

    expect(t2.tier2?.computed).toBe(4);
    expect(t2.tier25?.length).toBe(2);
    expect(stub.calls).toHaveLength(8);

    const catalogA_row = qa.rt.handle.db
      .prepare<[string, string], { body: string }>(
        `SELECT body FROM notes WHERE folder_id = ? AND source = ?`,
      )
      .get(folderA.id, 'mo:catalog');
    const catalogB_row = qa.rt.handle.db
      .prepare<[string, string], { body: string }>(
        `SELECT body FROM notes WHERE folder_id = ? AND source = ?`,
      )
      .get(folderB.id, 'mo:catalog');
    expect(catalogA_row).toBeDefined();
    expect(catalogB_row).toBeDefined();
    // Each folder got its own catalog body (the response queue
    // delivered them in the order Tier 2.5 was invoked).
    const bodies = new Set([catalogA_row!.body, catalogB_row!.body]);
    expect(bodies.size).toBe(2);
  });

  it('Case 27: Tier 2 had successes but folder catalog regen returns empty/no_clusters when assignments cleared mid-tick', async () => {
    const folder = qa.rt.folders.create('Drained');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const note = qa.rt.notes.create(
      { body: longBody('drained'), folderId: folder.id, source: 'user' },
      'user',
    );
    // Tier 1 will emit cluster assignments. Set them up via an upfront
    // Tier 1 cycle, then DELETE the assignments before Tier 2.5 runs
    // — simulates a race where the user manually reclassified
    // everything between Tier 2 and Tier 2.5.
    const tier2Body = [
      '<!-- mo:section-start id="overview" -->',
      'Cluster body',
      '<!-- mo:section-end id="overview" -->',
    ].join('\n');
    let callIdx = 0;
    const responses = [tier1Json, tier2Body, tier2Body];
    const stub = new StubProvider(() => {
      const content = responses[callIdx] ?? '';
      callIdx++;
      // After the second LLM call (last Tier 2), nuke note_mo_clusters
      // so Tier 2.5's snapshotFolderClusters returns empty.
      if (callIdx === 3) {
        qa.rt.handle.db.prepare(`DELETE FROM note_mo_clusters`).run();
      }
      return { content };
    });
    let nowVal = 1000;
    const deps = buildIndexingDeps(qa.rt, () => defaultProvider(stub));
    deps.now = () => nowVal;

    await runMoIndexingTick(deps);
    nowVal = 70_000;
    const t2 = await runMoIndexingTick(deps);
    expect(t2.tier2?.computed).toBe(2);
    expect(t2.tier25?.length).toBe(1);
    expect(t2.tier25?.[0]?.status).toBe('empty');
    if (t2.tier25?.[0]?.status === 'empty') {
      expect(t2.tier25[0]?.reason).toBe('no_clusters');
    }
    void note;
  });

  it('Case 28: Tier 2.5 failure does NOT poison Tier 1 + Tier 2 results in same tick', async () => {
    const folder = qa.rt.folders.create('Resilient');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    qa.rt.notes.create(
      { body: longBody('r1'), folderId: folder.id, source: 'user' },
      'user',
    );
    // Stub: Tier 1 ok, Tier 2 ok, Tier 2.5 → empty content (invalid_response)
    const tier2Body = [
      '<!-- mo:section-start id="overview" -->',
      'Tier 2 fine',
      '<!-- mo:section-end id="overview" -->',
    ].join('\n');
    let callIdx = 0;
    const responses = [tier1Json, tier2Body, tier2Body, '', ''];
    const stub = new StubProvider(() => ({
      content: responses[callIdx++] ?? '',
    }));
    let nowVal = 1000;
    const deps = buildIndexingDeps(qa.rt, () => defaultProvider(stub));
    deps.now = () => nowVal;

    await runMoIndexingTick(deps);
    nowVal = 70_000;
    const t2 = await runMoIndexingTick(deps);

    // Tier 2 succeeded for both clusters.
    expect(t2.tier2?.computed).toBe(2);
    // Tier 2.5 attempted once — but returned an error (empty content).
    expect(t2.tier25?.length).toBe(1);
    expect(t2.tier25?.[0]?.status).toBe('error');

    // Cluster aggregator notes are still there from Tier 2 success.
    const clusterRows = qa.rt.handle.db
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM notes WHERE folder_id = ? AND source = ?`,
      )
      .all(folder.id, 'mo:cluster');
    expect(clusterRows).toHaveLength(2);

    // No catalog body was written (lazy-create may have made the note
    // skeleton, but invalid_response means no merge happened).
    const catalog = qa.rt.handle.db
      .prepare<[string, string], { body: string }>(
        `SELECT body FROM notes WHERE folder_id = ? AND source = ?`,
      )
      .get(folder.id, 'mo:catalog');
    if (catalog) {
      // Skeleton placeholder still in place — no real overview content.
      expect(catalog.body).toContain('Mo will fill this in on the next patrol');
    }
  });
});

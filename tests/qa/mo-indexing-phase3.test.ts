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
 * QA — Mo Indexing Phase 3 integration (Tier 2 cluster regen)
 *
 * Extracted 2026-05-16 from tests/qa/mo-indexing-integration.test.ts
 * (Morion ticket 01KRJZ3Q7W0KREH04R0WK5V6F9). Drives the full
 * indexing pipeline against an on-disk SQLite DB wired through
 * buildRuntime — production path, LLM stubbed at the provider seam.
 */

describe('QA — Mo Indexing Phase 3 integration (Tier 2 cluster regen)', () => {
  let qa: QaCtx;

  beforeEach(() => {
    qa = setupQa();
  });

  afterEach(() => {
    qa.cleanup();
  });

  it('Case 21: Full pipeline — edit → tick 1 (Tier 1) → tick 2 with debounce expired (Tier 2) → mo:cluster note materialised', async () => {
    const folder = qa.rt.folders.create('Pipeline');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    qa.rt.notes.create(
      { body: longBody('p1'), folderId: folder.id, source: 'user' },
      'user',
    );

    // tier1Json emits 2 cluster_candidates → tick 2 drains BOTH clusters
    // → 2 Tier 2 calls + 1 Tier 2.5 catalog regen (Phase 4b hook fires
    // once per folder with Tier 2 success).
    // Total LLM calls: 1 Tier 1 + 2 Tier 2 + 1 Tier 2.5 = 4.
    const tier2Body = [
      '<!-- mo:section-start id="overview" -->',
      'Pipeline-test cluster covers QA work.',
      '<!-- mo:section-end id="overview" -->',
    ].join('\n');
    const catalogBody = [
      '<!-- mo:section-start id="overview" -->',
      'Folder-level catalog overview.',
      '<!-- mo:section-end id="overview" -->',
    ].join('\n');
    let callIdx = 0;
    const responses = [tier1Json, tier2Body, tier2Body, catalogBody];
    const stub = new StubProvider(() => ({
      content: responses[callIdx++] ?? '',
    }));

    let nowVal = 1000;
    const deps = buildIndexingDeps(qa.rt, () => defaultProvider(stub));
    deps.now = () => nowVal;

    // Tick 1 at t=1000: Tier 1 fires; cluster queue gets dirty clusters
    // with dirty_since=1000. Tier 2 debounce (60s) blocks same-tick regen.
    const t1 = await runMoIndexingTick(deps);
    expect(t1.worker?.computed).toBe(1);
    expect(t1.tier2?.claimed).toBe(0);
    expect(stub.calls).toHaveLength(1);

    // Advance now past the debounce window.
    nowVal = 70_000;
    const t2 = await runMoIndexingTick(deps);
    expect(t2.tier2?.computed).toBe(2); // both clusters drained
    expect(t2.tier25?.length).toBe(1); // one folder catalog regen
    expect(stub.calls).toHaveLength(4); // 1 tier1 + 2 tier2 + 1 tier2.5

    // Aggregator notes materialised — one per cluster id.
    const aggregators = qa.rt.handle.db
      .prepare<[string, string], { id: string; title: string; body: string }>(
        `SELECT id, title, body FROM notes WHERE folder_id = ? AND source = ?
         ORDER BY title ASC`,
      )
      .all(folder.id, 'mo:cluster');
    expect(aggregators).toHaveLength(2);
    for (const agg of aggregators) {
      expect(agg.title).toMatch(/^mo:cluster:/);
      expect(agg.body).toContain('Pipeline-test cluster covers QA work');
    }

    // Folder catalog materialised — Phase 4b hook.
    const catalog = qa.rt.handle.db
      .prepare<[string, string], { body: string }>(
        `SELECT body FROM notes WHERE folder_id = ? AND source = ?`,
      )
      .get(folder.id, 'mo:catalog');
    expect(catalog).toBeDefined();
    expect(catalog!.body).toContain('Folder-level catalog overview');
  });

  it('Case 22: Cluster regen preserves user prose across runs', async () => {
    const folder = qa.rt.folders.create('Preserve');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    // Use a tier1 response with a SINGLE cluster so we have one
    // aggregator note to track across runs.
    const tier1OneCluster = JSON.stringify({
      summary: 'Single-cluster preserve case.',
      keywords: ['preserve'],
      cluster_candidates: [{ cluster_id: 'preserve-cluster', confidence: 0.95 }],
    });
    const sourceNote = qa.rt.notes.create(
      { body: longBody('preserve'), folderId: folder.id, source: 'user' },
      'user',
    );
    const tier2v1 = [
      '<!-- mo:section-start id="overview" -->',
      'first overview',
      '<!-- mo:section-end id="overview" -->',
    ].join('\n');
    const tier2v2 = [
      '<!-- mo:section-start id="overview" -->',
      'second overview',
      '<!-- mo:section-end id="overview" -->',
    ].join('\n');
    const catalogV1 = [
      '<!-- mo:section-start id="overview" -->',
      'catalog v1',
      '<!-- mo:section-end id="overview" -->',
    ].join('\n');
    const catalogV2 = [
      '<!-- mo:section-start id="overview" -->',
      'catalog v2',
      '<!-- mo:section-end id="overview" -->',
    ].join('\n');
    // Per cycle: Tier 1 + Tier 2 + Tier 2.5 = 3 calls.
    let callIdx = 0;
    const responses = [
      tier1OneCluster, tier2v1, catalogV1,
      tier1OneCluster, tier2v2, catalogV2,
    ];
    const stub = new StubProvider(() => ({
      content: responses[callIdx++] ?? '',
    }));
    let nowVal = 1000;
    const deps = buildIndexingDeps(qa.rt, () => defaultProvider(stub));
    deps.now = () => nowVal;

    await runMoIndexingTick(deps); // tick 1 — Tier 1
    nowVal = 70_000;
    await runMoIndexingTick(deps); // tick 2 — Tier 2 v1

    // User edits the aggregator note: appends a paragraph BEFORE
    // the first anchor. This is the user-prose-is-sacred contract.
    const aggregator = qa.rt.handle.db
      .prepare<[string, string], { id: string; body: string }>(
        `SELECT id, body FROM notes WHERE folder_id = ? AND source = ?`,
      )
      .get(folder.id, 'mo:cluster')!;
    const userEdited =
      'My personal preamble that Mo must not erase.\n\n' + aggregator.body;
    qa.rt.handle.db
      .prepare('UPDATE notes SET body = ? WHERE id = ?')
      .run(userEdited, aggregator.id);

    // Edit the source note → tick 3 (Tier 1) → tick 4 (Tier 2 v2)
    qa.rt.notes.update(
      sourceNote.id,
      { body: longBody('preserve-v2') },
      'user',
    );
    nowVal = 100_000;
    await runMoIndexingTick(deps); // tier 1 v2 + tier 2 not eligible
    nowVal = 200_000;
    await runMoIndexingTick(deps); // tier 2 v2

    const final = qa.rt.handle.db
      .prepare<[string], { body: string }>(
        'SELECT body FROM notes WHERE id = ?',
      )
      .get(aggregator.id)!.body;
    expect(final).toContain('My personal preamble that Mo must not erase');
    expect(final).toContain('second overview');
    expect(final).not.toContain('first overview');
  });

  it('Case 23: Tier 2 debounce respected — same-tick regen impossible', async () => {
    const folder = qa.rt.folders.create('Debounce');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    qa.rt.notes.create(
      { body: longBody('d1'), folderId: folder.id, source: 'user' },
      'user',
    );
    const stub = new StubProvider(() => ({ content: tier1Json }));
    const deps = buildIndexingDeps(qa.rt, () => defaultProvider(stub));
    let nowVal = 1000;
    deps.now = () => nowVal;

    const summary = await runMoIndexingTick(deps);
    expect(summary.worker?.computed).toBe(1);
    expect(summary.tier2?.claimed).toBe(0);
    // No mo:cluster note exists yet — Tier 2 didn't run.
    const clusterNote = qa.rt.handle.db
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM notes WHERE folder_id = ? AND source = ?`,
      )
      .get(folder.id, 'mo:cluster');
    expect(clusterNote).toBeUndefined();
  });

  it('Case 24: Tier 2 empty cluster (no Tier 1 metadata yet) → completes queue row, no LLM call', async () => {
    const folder = qa.rt.folders.create('EmptyClu');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    // Manually enqueue a cluster row that points to a cluster id with
    // zero notes — simulates a Tier 1 result that emitted a cluster
    // but the source notes got deleted before Tier 2 caught up.
    qa.rt.concierge.moClusterQueue.enqueue(folder.id, 'orphan-cluster', 1000);

    const stub = new StubProvider(() => ({
      content: 'should not be called',
    }));
    let nowVal = 100_000;
    const deps = buildIndexingDeps(qa.rt, () => defaultProvider(stub));
    deps.now = () => nowVal;

    const summary = await runMoIndexingTick(deps);
    expect(summary.tier2?.empty).toBe(1);
    expect(summary.tier2?.computed).toBe(0);
    expect(stub.calls).toHaveLength(0);
    // Queue row gone — no infinite re-poll on an empty cluster.
    expect(
      qa.rt.concierge.moClusterQueue.listForFolder(folder.id),
    ).toHaveLength(0);
  });

  it('Case 25: Tier 2 budget exhausted → abandons cluster', async () => {
    const folder = qa.rt.folders.create('OverBudget');
    qa.rt.concierge.folderSettings.update(folder.id, { enabled: true });
    const note = qa.rt.notes.create(
      { body: longBody('b1'), folderId: folder.id, source: 'user' },
      'user',
    );
    // Pre-seed Tier 1 metadata + cluster assignment so the cluster
    // queue row will have notes available; budget block kicks in
    // BEFORE the LLM call.
    qa.rt.concierge.moMetadata.upsert({
      noteId: note.id,
      summary: 'Sum',
      bodyHash: 'h',
      computedBy: 'tier1',
      computedAt: 1,
    });
    qa.rt.concierge.moClusters.upsert({
      noteId: note.id,
      clusterId: 'budget-cluster',
      source: 'tier1',
    });
    qa.rt.concierge.moClusterQueue.enqueue(folder.id, 'budget-cluster', 1000);
    qa.rt.concierge.moSpendLedger.record({ kind: 'mo_tool', costUsd: 11 });

    const stub = new StubProvider(() => ({
      content: 'unused',
    }));
    let nowVal = 100_000;
    const deps = buildIndexingDeps(qa.rt, () => defaultProvider(stub));
    deps.now = () => nowVal;

    const summary = await runMoIndexingTick(deps);
    expect(summary.tier2?.abandoned).toBe(1);
    expect(summary.tier2?.abandonedItems[0]?.reason).toBe('budget_exceeded');
    expect(stub.calls).toHaveLength(0);
    expect(
      qa.rt.concierge.moClusterQueue.listForFolder(folder.id),
    ).toHaveLength(0);
    // No mo:cluster note created.
    const aggregator = qa.rt.handle.db
      .prepare<[string, string], { id: string }>(
        `SELECT id FROM notes WHERE folder_id = ? AND source = ?`,
      )
      .get(folder.id, 'mo:cluster');
    expect(aggregator).toBeUndefined();
  });
});

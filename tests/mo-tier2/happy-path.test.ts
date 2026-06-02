import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseClusterDoc,
  runTier2ForCluster,
} from '../../src/core/concierge/index.js';
import {
  StubProvider,
  sampleNoteBody,
  setup,
  tier2Body,
  type Ctx,
} from '../helpers/mo-tier2-setup.js';

describe('runTier2ForCluster — happy path', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('writes merged anchored sections + records spend + emits audit update', async () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create(
      { body: sampleNoteBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );
    const b = ctx.notes.create(
      { body: sampleNoteBody('B'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: a.id,
      summary: 'Summary for A',
      keywords: ['k1'],
      bodyHash: 'ha',
      computedBy: 'tier1',
      computedAt: 1,
      confidence: 0.9,
    });
    ctx.meta.upsert({
      noteId: b.id,
      summary: 'Summary for B',
      keywords: ['k2'],
      bodyHash: 'hb',
      computedBy: 'tier1',
      computedAt: 1,
      confidence: 0.9,
    });
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'cluster-x', source: 'tier1' });
    ctx.clusters.upsert({ noteId: b.id, clusterId: 'cluster-x', source: 'tier1' });

    const stub = new StubProvider(async (req) => ({
      content: tier2Body({
        overview: 'Cluster X covers test work.',
        state: '- 2 notes total',
      }),
      toolCalls: [],
      tokensIn: 200,
      tokensOut: 100,
      costUsd: 0.001,
      model: req.model,
    }));

    const result = await runTier2ForCluster(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub,
        budget: ctx.budget,
        model: 'qwen/qwen3-235b-a22b-2507',
      },
      folder.id,
      'cluster-x',
    );
    expect(result.status).toBe('computed');
    if (result.status !== 'computed') return;
    expect(result.noteCount).toBe(2);
    expect(stub.calls).toHaveLength(1);

    const stored = ctx.handle.db
      .prepare<[string], { body: string }>(
        'SELECT body FROM notes WHERE id = ?',
      )
      .get(result.clusterNoteId);
    const parsed = parseClusterDoc(stored?.body ?? '');
    expect(parsed.sections.overview).toContain('Cluster X covers test work');
    expect(parsed.sections.state).toContain('2 notes total');

    // Audit: 1 create (ensureClusterNote) + 1 update (post-merge).
    const auditRows = ctx.handle.db
      .prepare<[string], { action: string }>(
        'SELECT action FROM audit_log WHERE note_id = ? ORDER BY ts ASC',
      )
      .all(result.clusterNoteId);
    expect(auditRows.map((r) => r.action)).toEqual(['create', 'update']);
  });

  // PINNED INVARIANT (CLAUDE.md): human text outside `<!-- mo:section-start -->`
  // markers is sacred. Tier 2 refreshes must only replace anchored sections.
  it('preserves user prose between Tier 2 runs (anchored-section invariant)', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleNoteBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: note.id,
      summary: 'Summary for A',
      bodyHash: 'h',
      computedBy: 'tier1',
      computedAt: 1,
      confidence: 0.9,
    });
    ctx.clusters.upsert({
      noteId: note.id,
      clusterId: 'cluster-y',
      source: 'tier1',
    });
    // First run — populate the aggregator.
    const stub = new StubProvider(async (req) => ({
      content: tier2Body({ overview: 'first overview' }),
      toolCalls: [],
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      model: req.model,
    }));
    const r1 = await runTier2ForCluster(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub,
        model: 'm',
      },
      folder.id,
      'cluster-y',
    );
    expect(r1.status).toBe('computed');
    if (r1.status !== 'computed') return;

    // User adds a paragraph BEFORE the first anchor.
    const userEdited =
      'My personal notes about this cluster.\n\n' +
      ctx.handle.db
        .prepare<[string], { body: string }>(
          'SELECT body FROM notes WHERE id = ?',
        )
        .get(r1.clusterNoteId)!.body;
    ctx.handle.db
      .prepare('UPDATE notes SET body = ? WHERE id = ?')
      .run(userEdited, r1.clusterNoteId);

    // Second run — Tier 2 should not erase the user prose.
    const stub2 = new StubProvider(async (req) => ({
      content: tier2Body({ overview: 'second overview' }),
      toolCalls: [],
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      model: req.model,
    }));
    const r2 = await runTier2ForCluster(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub2,
        model: 'm',
      },
      folder.id,
      'cluster-y',
    );
    expect(r2.status).toBe('computed');
    const finalBody = ctx.handle.db
      .prepare<[string], { body: string }>(
        'SELECT body FROM notes WHERE id = ?',
      )
      .get(r1.clusterNoteId)!.body;
    expect(finalBody).toContain('My personal notes about this cluster.');
    expect(finalBody).toContain('second overview');
    expect(finalBody).not.toContain('first overview');
  });
});

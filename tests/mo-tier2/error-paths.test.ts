import { describe, it, expect, beforeEach } from 'vitest';
import { runTier2ForCluster } from '../../src/core/concierge/index.js';
import {
  StubProvider,
  sampleNoteBody,
  setup,
  tier2Body,
  type Ctx,
} from '../helpers/mo-tier2-setup.js';

describe('runTier2ForCluster — empty/error paths', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns empty / no_notes when no notes are assigned', async () => {
    const folder = ctx.folders.create('F');
    const stub = new StubProvider(async () => {
      throw new Error('provider should not be called');
    });
    const r = await runTier2ForCluster(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub,
        model: 'm',
      },
      folder.id,
      'unknown',
    );
    expect(r.status).toBe('empty');
    if (r.status !== 'empty') return;
    expect(r.reason).toBe('no_notes');
  });

  it('returns empty / not_ready when no assigned notes have Tier 1 metadata', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleNoteBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'cluster-a', source: 'tier1' });
    // No metadata upsert for the note → not_ready.
    const stub = new StubProvider(async () => {
      throw new Error('should not be called');
    });
    const r = await runTier2ForCluster(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub,
        model: 'm',
      },
      folder.id,
      'cluster-a',
    );
    expect(r.status).toBe('empty');
    if (r.status !== 'empty') return;
    expect(r.reason).toBe('not_ready');
  });

  it('returns error / budget_exceeded BEFORE the LLM call', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleNoteBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: note.id,
      summary: 'sum',
      bodyHash: 'h',
      computedBy: 'tier1',
      computedAt: 1,
    });
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'cluster-a', source: 'tier1' });
    ctx.ledger.record({ kind: 'mo_tool', costUsd: 11 });
    const stub = new StubProvider(async (req) => ({
      content: tier2Body(),
      toolCalls: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      model: req.model,
    }));
    const r = await runTier2ForCluster(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub,
        budget: ctx.budget,
        model: 'm',
      },
      folder.id,
      'cluster-a',
    );
    expect(r.status).toBe('error');
    if (r.status !== 'error') return;
    expect(r.reason).toBe('budget_exceeded');
    expect(stub.calls).toHaveLength(0);
  });

  it('returns error / invalid_response when LLM returns content without anchors', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleNoteBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: note.id,
      summary: 'sum',
      bodyHash: 'h',
      computedBy: 'tier1',
      computedAt: 1,
    });
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'cluster-a', source: 'tier1' });
    const stub = new StubProvider(async (req) => ({
      content: 'just plain prose with no anchored sections at all',
      toolCalls: [],
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.0001,
      model: req.model,
    }));
    const r = await runTier2ForCluster(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub,
        budget: ctx.budget,
        model: 'm',
      },
      folder.id,
      'cluster-a',
    );
    expect(r.status).toBe('error');
    if (r.status !== 'error') return;
    expect(r.reason).toBe('invalid_response');
    // Spend recorded — provider billed us. Lands under
    // mo_indexing_tier2 (slice 2 of ticket 01KRJSTN74FT7VRX6KAA42GGBS).
    const status = ctx.budget.status();
    expect(status.spentMonthBreakdown.mo_indexing_tier2).toBeGreaterThan(0);
  });

  it('returns error / provider_failed when the provider throws', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleNoteBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: note.id,
      summary: 'sum',
      bodyHash: 'h',
      computedBy: 'tier1',
      computedAt: 1,
    });
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'cluster-a', source: 'tier1' });
    const stub = new StubProvider(async () => {
      throw new Error('oops 503');
    });
    const r = await runTier2ForCluster(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub,
        model: 'm',
      },
      folder.id,
      'cluster-a',
    );
    expect(r.status).toBe('error');
    if (r.status !== 'error') return;
    expect(r.reason).toBe('provider_failed');
    expect(r.message).toContain('oops 503');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { runTier1ForNote } from '../../src/core/concierge/index.js';
import {
  setupMoTier1Ctx,
  StubProvider,
  sampleBody,
  type MoTier1Ctx,
} from '../helpers/mo-tier1-setup.js';

describe('runTier1ForNote — failure modes', () => {
  let ctx: MoTier1Ctx;
  beforeEach(() => {
    ctx = setupMoTier1Ctx();
  });

  it('records spend and returns error / invalid_json on unparseable response', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleBody, folderId: folder.id, source: 'user' },
      'user',
    );
    const provider = new StubProvider({
      content: 'not json, just prose',
      costUsd: 0.0001,
    });
    const result = await runTier1ForNote(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider,
        budget: ctx.budget,
        model: 'm',
      },
      note.id,
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toBe('invalid_json');
    expect(ctx.meta.get(note.id)).toBeNull();
    // Spend WAS recorded — provider billed us. Lands under
    // mo_indexing_tier1 (slice 2 of ticket 01KRJSTN74FT7VRX6KAA42GGBS).
    const status = ctx.budget.status();
    expect(status.spentMonthBreakdown.mo_indexing_tier1).toBeCloseTo(0.0001, 6);
  });

  it('returns error / provider_failed when the provider throws', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleBody, folderId: folder.id, source: 'user' },
      'user',
    );
    const provider = new StubProvider({
      content: '',
      throwError: new Error('provider exploded'),
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
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toBe('provider_failed');
    expect(result.message).toContain('provider exploded');
  });

  it('returns error / budget_exceeded BEFORE the LLM call when over cap', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleBody, folderId: folder.id, source: 'user' },
      'user',
    );
    // Pre-record $11 of spend -> over the $10 cap.
    ctx.ledger.record({ kind: 'mo_tool', costUsd: 11 });

    const provider = new StubProvider({
      content: JSON.stringify({
        summary: 's',
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
        budget: ctx.budget,
        model: 'm',
      },
      note.id,
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.reason).toBe('budget_exceeded');
    expect(provider.calls).toHaveLength(0);
  });
});

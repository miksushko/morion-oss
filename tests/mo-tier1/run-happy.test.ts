import { describe, it, expect, beforeEach } from 'vitest';
import { hashBody, runTier1ForNote } from '../../src/core/concierge/index.js';
import {
  setupMoTier1Ctx,
  StubProvider,
  sampleBody,
  type MoTier1Ctx,
} from '../helpers/mo-tier1-setup.js';

describe('runTier1ForNote — happy path', () => {
  let ctx: MoTier1Ctx;
  beforeEach(() => {
    ctx = setupMoTier1Ctx();
  });

  it('writes summary + keywords + clusters and records spend', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: sampleBody, folderId: folder.id, source: 'user' },
      'user',
    );
    const provider = new StubProvider({
      content: JSON.stringify({
        summary: 'Bug fix for orphan tool messages in chat history.',
        keywords: ['mo', 'chat', 'history', 'tool-calls'],
        cluster_candidates: [
          { cluster_id: 'mo-chat-loop', confidence: 0.95 },
          { cluster_id: 'infra-bugs', confidence: 0.6 },
        ],
      }),
      costUsd: 0.0002,
    });

    // Don't pin `now` — the BudgetTracker.status() query uses
    // startOfUtcMonth(Date.now()) as its lower bound; a fixed
    // epoch-near-zero `now` would land the recorded spend row in
    // 1970 and not show up in the current-month aggregate.
    const result = await runTier1ForNote(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider,
        budget: ctx.budget,
        model: 'mistralai/mistral-nemo',
      },
      note.id,
      { knownClusters: ['mo-chat-loop', 'infra-bugs'] },
    );

    expect(result.status).toBe('computed');
    if (result.status !== 'computed') return;
    expect(result.bodyHash).toBe(hashBody(sampleBody));

    const meta = ctx.meta.get(note.id);
    expect(meta!.summary).toContain('orphan tool');
    expect(meta!.keywords).toContain('mo');
    expect(meta!.bodyHash).toBe(hashBody(sampleBody));
    expect(meta!.computedBy).toBe('tier1');

    const clusters = ctx.clusters.listForNote(note.id);
    expect(clusters.map((c) => c.clusterId).sort()).toEqual([
      'infra-bugs',
      'mo-chat-loop',
    ]);
    expect(
      clusters.find((c) => c.clusterId === 'mo-chat-loop')?.confidence,
    ).toBe(0.95);
    // Spend recorded under mo_indexing_tier1 (slice 2 of ticket
    // 01KRJSTN74FT7VRX6KAA42GGBS — was `mo_tool` pre-split).
    const status = ctx.budget.status();
    expect(status.spentMonthBreakdown.mo_indexing_tier1).toBeCloseTo(0.0002, 6);
  });
});

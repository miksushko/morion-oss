import { describe, it, expect, beforeEach } from 'vitest';
import {
  gatherContext,
  type GatherProgressEvent,
} from '../../src/core/concierge/index.js';
import {
  setup,
  GatherStubProvider,
  defaultResponder,
  type Ctx,
} from '../helpers/mo-gather-setup.js';

describe('gatherContext — full pipeline (taskId mode)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('runs Wave 1 + Wave 2 + synth and produces a packet with citedNoteIds', async () => {
    const folder = ctx.folders.create('Stripe Project');
    const task = ctx.notes.create(
      {
        body: '# Implement Stripe webhook idempotency\n\nUse event_id as dedupe key.',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    const sibling = ctx.notes.create(
      {
        body: '# Prior Stripe webhook bug\n\nWe deduplicated via event_id.',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    ctx.clusters.upsert({
      noteId: task.id,
      clusterId: 'stripe',
      source: 'tier1',
      confidence: 0.95,
    });
    ctx.clusters.upsert({
      noteId: sibling.id,
      clusterId: 'stripe',
      source: 'tier1',
      confidence: 0.9,
    });
    ctx.meta.upsert({
      noteId: task.id,
      summary: 'Stripe idempotency.',
      keywords: ['stripe'],
      computedBy: 'tier1',
    });
    ctx.meta.upsert({
      noteId: sibling.id,
      summary: 'Past Stripe dedupe pattern.',
      keywords: ['stripe', 'dedupe'],
      computedBy: 'tier1',
    });

    // Cluster analyst picks the sibling. Body extractor pulls a chunk.
    // Synthesizer cites the sibling.
    const provider = new GatherStubProvider((req) => {
      const sys = req.messages[0]!.content;
      if (sys.includes('task-cluster-analyst')) {
        return {
          content: JSON.stringify({
            drillIntoNoteIds: [sibling.id],
            why: 'Sibling note documents the dedupe approach.',
          }),
        };
      }
      return defaultResponder(req);
    });

    const events: GatherProgressEvent[] = [];
    const packet = await gatherContext(
      { taskId: task.id, folderId: folder.id },
      {
        ctx: ctx.toolCtx,
        provider,
        subagentModel: 'stub',
        synthesisModel: 'stub',
        budget: ctx.budget,
        onProgress: (e) => events.push(e),
      },
    );

    expect(packet.synthesizedMarkdown).toContain('Stripe');
    expect(packet.citedNoteIds).toEqual(['01HABC']); // from canned synth
    expect(packet.spentUsd).toBeGreaterThan(0);
    expect(packet.cacheHit).toBeNull();

    // Progress events fire in order.
    const eventKinds = events.map((e) => e.kind);
    expect(eventKinds).toContain('bootstrap_complete');
    expect(eventKinds).toContain('wave_start');
    expect(eventKinds).toContain('wave_complete');
    expect(eventKinds).toContain('synthesis_complete');
  });

  it('falls back gracefully when synthesizer returns malformed JSON', async () => {
    const folder = ctx.folders.create('F');
    const task = ctx.notes.create(
      {
        body: '# Task body long enough to clear the gate',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );

    const provider = new GatherStubProvider((req) => {
      const sys = req.messages[0]!.content;
      if (sys.includes('gather-synthesizer')) {
        return { content: 'this is not JSON at all' };
      }
      return defaultResponder(req);
    });

    const packet = await gatherContext(
      { taskId: task.id, folderId: folder.id },
      {
        ctx: ctx.toolCtx,
        provider,
        subagentModel: 'stub',
        synthesisModel: 'stub',
        budget: ctx.budget,
      },
    );

    expect(packet.synthesizedMarkdown).toContain('synthesis unavailable');
    expect(packet.warnings.some((w) => w.includes('Synthesis failed'))).toBe(
      true,
    );
  });
});

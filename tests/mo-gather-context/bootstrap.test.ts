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

describe('gatherContext — bootstrap', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('taskId path resolves task body, folder, clusters, metadata, comments, audit', async () => {
    const folder = ctx.folders.create('Stripe Project');
    const task = ctx.notes.create(
      {
        body: '# Implement Stripe webhook idempotency\n\nUse event_id as the dedupe key.',
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
    ctx.meta.upsert({
      noteId: task.id,
      summary: 'Stripe idempotency implementation.',
      keywords: ['stripe', 'idempotency'],
      computedBy: 'tier1',
    });

    const events: GatherProgressEvent[] = [];
    const provider = new GatherStubProvider(defaultResponder);
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

    expect(packet.bootstrap.taskId).toBe(task.id);
    expect(packet.bootstrap.folderId).toBe(folder.id);
    expect(packet.bootstrap.clusterIds).toEqual(['stripe']);
    expect(packet.bootstrap.auditCount).toBeGreaterThan(0);
    expect(events.find((e) => e.kind === 'bootstrap_complete')).toBeTruthy();
  });

  it('question path skips taskId-only state but still completes', async () => {
    const provider = new GatherStubProvider(defaultResponder);
    const packet = await gatherContext(
      { question: 'How do we handle Stripe webhook idempotency?' },
      {
        ctx: ctx.toolCtx,
        provider,
        subagentModel: 'stub',
        synthesisModel: 'stub',
        budget: ctx.budget,
      },
    );
    expect(packet.bootstrap.taskId).toBeNull();
    expect(packet.bootstrap.clusterIds).toEqual([]);
    expect(packet.synthesizedMarkdown).toContain('Stripe');
  });
});

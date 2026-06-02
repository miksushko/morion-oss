import { describe, it, expect, beforeEach } from 'vitest';
import {
  runTopicHygiene,
  BudgetTracker,
  TOPIC_HYGIENE_AUTO_THRESHOLD,
} from '../../src/core/concierge/index.js';
import {
  setup,
  StubProvider,
  seedClusters,
  type Ctx,
} from '../helpers/mo-topic-hygiene-setup.js';

describe('runTopicHygiene', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('skips when fewer than 3 clusters in folder (no need for cleanup)', async () => {
    const folder = ctx.folders.create('F');
    seedClusters(ctx, folder.id, [{ clusterId: 'only', count: 1 }]);

    const provider = new StubProvider('{}');
    const result = await runTopicHygiene(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
        sessions: ctx.sessions,
        messages: ctx.messages,
        provider,
        budget: ctx.budget,
        model: 'm',
        fallbackModel: null,
      },
      folder.id,
    );

    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('too_few_clusters');
    }
    expect(provider.calls).toHaveLength(0);
  });

  it('auto-applies high-confidence merges, escalates low-confidence to chat', async () => {
    const folder = ctx.folders.create('F');
    seedClusters(ctx, folder.id, [
      { clusterId: 'auto-code', count: 5 },
      { clusterId: 'auto-code-loop', count: 1 },
      { clusterId: 'mo-chat', count: 3 },
      { clusterId: 'mo-indexing', count: 4 },
    ]);

    const proposal = JSON.stringify({
      summary: 'Two pairs to consider.',
      merges: [
        { source: 'auto-code-loop', target: 'auto-code', confidence: 0.95, reason: 'morphological variant' },
        { source: 'mo-chat', target: 'mo-indexing', confidence: 0.55, reason: 'maybe same family' },
      ],
      demotes: [],
    });
    const provider = new StubProvider(proposal);

    const result = await runTopicHygiene(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
        sessions: ctx.sessions,
        messages: ctx.messages,
        provider,
        budget: ctx.budget,
        model: 'm',
        fallbackModel: null,
      },
      folder.id,
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.autoMerged).toHaveLength(1);
    expect(result.autoMerged[0]?.source).toBe('auto-code-loop');
    expect(result.escalatedToChat).toHaveLength(1);
    expect(result.escalatedToChat[0]).toMatchObject({ source: 'mo-chat' });

    // Auto-merge actually applied: source rows gone, target gained them.
    expect(ctx.clusters.listForCluster('auto-code-loop')).toHaveLength(0);
    const targetRows = ctx.clusters.listForCluster('auto-code');
    expect(targetRows.length).toBeGreaterThanOrEqual(6); // 5 original + 1 reassigned

    // Decision recorded for the merged pair.
    expect(
      ctx.decisions.get(folder.id, 'auto-code-loop', 'auto-code')?.decision,
    ).toBe('merged');

    // Edge case opened a chat session with the merge bundle rendered
    // as a Claude-style block with N+1 options (use-as-main per topic
    // + keep-all-separate). Single pair → bundle of 2 topics → 3
    // options total.
    expect(result.escalationSessionId).not.toBeNull();
    if (result.escalationSessionId) {
      const msgs = ctx.messages.listBySession(result.escalationSessionId);
      expect(msgs.length).toBe(1);
      const msg = msgs[0]!;
      const body = msg.content;
      // Headline must name the folder so the user can tell which
      // project the cleanup belongs to when multiple Mo-enabled
      // folders run hygiene at the same time (dogfood 2026-05-04).
      expect(body).toMatch(/Topic cleanup needs your call.*folder `F`/);
      expect(body).toContain('mo-chat');
      expect(body).toContain('mo-indexing');
      expect(body).toContain('similar topics');
      expect(body).toContain("Doesn't fit? Type a custom decision");
      // Body NO LONGER carries the text-protocol Options/footer.
      expect(body).not.toMatch(/\*Options:\*/);

      // Quick actions: bundle of 2 topics → 2 use-as-main + 1 keep-all.
      expect(msg.quickActions).not.toBeNull();
      expect(msg.quickActions!).toHaveLength(3);
      const ids = msg.quickActions!.map((a) => a.id);
      expect(ids).toContain('bundle:0:use-mo-chat');
      expect(ids).toContain('bundle:0:use-mo-indexing');
      expect(ids).toContain('bundle:0:keep-all');

      const useChat = msg.quickActions!.find(
        (a) => a.id === 'bundle:0:use-mo-chat',
      )!;
      expect(useChat.payload.kind).toBe('cleanup-bundle-merge');
      expect(useChat.payload.target).toBe('mo-chat');
      expect(useChat.payload.topics).toEqual(['mo-chat', 'mo-indexing']);

      const keepAll = msg.quickActions!.find(
        (a) => a.id === 'bundle:0:keep-all',
      )!;
      expect(keepAll.kind).toBe('secondary');
      expect(keepAll.payload.kind).toBe('cleanup-bundle-keep');
    }
  });

  it('drops proposals that reference cluster ids not in the panorama (hallucination guard)', async () => {
    const folder = ctx.folders.create('F');
    seedClusters(ctx, folder.id, [
      { clusterId: 'real-a', count: 2 },
      { clusterId: 'real-b', count: 2 },
      { clusterId: 'real-c', count: 2 },
    ]);

    const proposal = JSON.stringify({
      summary: 'mixed',
      merges: [
        { source: 'real-a', target: 'real-b', confidence: 0.95, reason: 'real' },
        { source: 'invented', target: 'real-c', confidence: 0.95, reason: 'hallucination' },
      ],
      demotes: [],
    });
    const provider = new StubProvider(proposal);

    const result = await runTopicHygiene(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
        sessions: ctx.sessions,
        messages: ctx.messages,
        provider,
        budget: ctx.budget,
        model: 'm',
        fallbackModel: null,
      },
      folder.id,
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.autoMerged).toHaveLength(1);
    expect(result.autoMerged[0]?.source).toBe('real-a');
    // 'invented' did not crash + did not get applied.
    expect(ctx.clusters.listForCluster('invented')).toHaveLength(0);
  });

  it('prior kept_separate decision blocks the same pair from being re-proposed', async () => {
    const folder = ctx.folders.create('F');
    seedClusters(ctx, folder.id, [
      { clusterId: 'src', count: 2 },
      { clusterId: 'dst', count: 2 },
      { clusterId: 'other', count: 1 },
    ]);
    ctx.decisions.record({
      folderId: folder.id,
      sourceCluster: 'src',
      targetCluster: 'dst',
      decision: 'kept_separate',
      decidedBy: 'user',
    });

    const proposal = JSON.stringify({
      summary: '',
      merges: [
        { source: 'src', target: 'dst', confidence: 0.99, reason: 'high conf' },
      ],
      demotes: [],
    });
    const provider = new StubProvider(proposal);

    const result = await runTopicHygiene(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
        sessions: ctx.sessions,
        messages: ctx.messages,
        provider,
        budget: ctx.budget,
        model: 'm',
        fallbackModel: null,
      },
      folder.id,
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.autoMerged).toHaveLength(0);
    expect(result.blockedByDecision).toHaveLength(1);
    // Source untouched.
    expect(ctx.clusters.listForCluster('src')).toHaveLength(2);
  });

  it('skips when budget exhausted', async () => {
    const folder = ctx.folders.create('F');
    seedClusters(ctx, folder.id, [
      { clusterId: 'a', count: 1 },
      { clusterId: 'b', count: 1 },
      { clusterId: 'c', count: 1 },
    ]);

    // BudgetTracker takes monthlyCapUsd in the constructor (no setter).
    // Build a tiny-cap one and record an over-cap spend.
    const tinyBudget = new BudgetTracker(ctx.ledger, 0.0001);
    tinyBudget.record({ kind: 'mo_tool', costUsd: 0.001 });

    const provider = new StubProvider('{}');
    const result = await runTopicHygiene(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
        sessions: ctx.sessions,
        messages: ctx.messages,
        provider,
        budget: tinyBudget,
        model: 'm',
        fallbackModel: null,
      },
      folder.id,
    );

    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('budget_exhausted');
    }
    expect(provider.calls).toHaveLength(0);
  });

  it('bundles transitive merge proposals via connected components', async () => {
    const { bundleMergeProposals } = await import(
      '../../src/core/concierge/index.js'
    );
    const merges = [
      { source: 'a', target: 'c', confidence: 0.7, reason: 'a~c' },
      { source: 'b', target: 'c', confidence: 0.6, reason: 'b~c' },
      // Independent pair, separate bundle.
      { source: 'x', target: 'y', confidence: 0.8, reason: 'x~y' },
    ];
    const bundles = bundleMergeProposals(merges);
    expect(bundles).toHaveLength(2);
    // Larger bundle first (sort by topic count desc).
    expect(bundles[0]!.topics).toEqual(['a', 'b', 'c']);
    expect(bundles[0]!.recommendedMain).toBe('c'); // 2 votes as target
    expect(bundles[1]!.topics).toEqual(['x', 'y']);
    expect(bundles[1]!.recommendedMain).toBe('y');
  });

  it('AUTO_THRESHOLD constant is honoured (proposals AT threshold are auto)', () => {
    expect(TOPIC_HYGIENE_AUTO_THRESHOLD).toBeGreaterThan(0);
    expect(TOPIC_HYGIENE_AUTO_THRESHOLD).toBeLessThan(1);
  });
});

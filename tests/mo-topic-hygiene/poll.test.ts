import { describe, it, expect, beforeEach } from 'vitest';
import {
  setup,
  StubProvider,
  seedClusters,
  type Ctx,
} from '../helpers/mo-topic-hygiene-setup.js';

describe('pollTopicHygieneAcrossFolders', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('runs folder when last-run > intervalMs ago, skips when within cooldown', async () => {
    // Two folders, both Mo-enabled, both with enough clusters to run.
    const folderA = ctx.folders.create('A');
    const folderB = ctx.folders.create('B');
    seedClusters(ctx, folderA.id, [
      { clusterId: 'a1', count: 1 },
      { clusterId: 'a2', count: 1 },
      { clusterId: 'a3', count: 1 },
    ]);
    seedClusters(ctx, folderB.id, [
      { clusterId: 'b1', count: 1 },
      { clusterId: 'b2', count: 1 },
      { clusterId: 'b3', count: 1 },
    ]);

    const provider = new StubProvider(
      JSON.stringify({ summary: '', merges: [], demotes: [] }),
    );

    const lastRun = new Map<string, number>();
    // folderA cooled down (just ran), folderB cold.
    const now = 10_000_000;
    lastRun.set(folderA.id, now - 1000); // 1s ago — within 4h cooldown

    const { pollTopicHygieneAcrossFolders } = await import(
      '../../src/core/concierge/index.js'
    );
    const summary = await pollTopicHygieneAcrossFolders({
      enabledFolderIds: [folderA.id, folderB.id],
      getLastRunAt: (id) => lastRun.get(id) ?? null,
      setLastRunAt: (id, ts) => lastRun.set(id, ts),
      getTopicExclusions: () => '',
      buildRunDeps: () => ({
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
      }),
      now: () => now,
    });

    expect(summary.considered).toBe(2);
    expect(summary.cooledDown).toBe(1);
    // folderB ran (status 'ok' even with empty proposal — that's an
    // 'ok' result with zero auto-merged).
    expect(summary.ranOk + summary.ranSkipped).toBe(1);
    expect(summary.details.find((d) => d.folderId === folderA.id)?.outcome).toBe(
      'cooled_down',
    );
    // Provider only got called for folderB.
    expect(provider.calls.length).toBe(1);

    // Last-run advanced for folderB.
    expect(lastRun.get(folderB.id)).toBe(now);
    // folderA still has its old timestamp.
    expect(lastRun.get(folderA.id)).toBe(now - 1000);
  });

  it('marks folder as gate_failed when buildRunDeps returns null', async () => {
    const folder = ctx.folders.create('F');
    seedClusters(ctx, folder.id, [
      { clusterId: 'a', count: 1 },
      { clusterId: 'b', count: 1 },
      { clusterId: 'c', count: 1 },
    ]);
    const { pollTopicHygieneAcrossFolders } = await import(
      '../../src/core/concierge/index.js'
    );
    const summary = await pollTopicHygieneAcrossFolders({
      enabledFolderIds: [folder.id],
      getLastRunAt: () => null,
      setLastRunAt: () => undefined,
      getTopicExclusions: () => '',
      buildRunDeps: () => null,
    });

    expect(summary.details[0]?.outcome).toBe('gate_failed');
    expect(summary.ranOk).toBe(0);
  });
});

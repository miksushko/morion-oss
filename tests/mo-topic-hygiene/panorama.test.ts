import { describe, it, expect, beforeEach } from 'vitest';
import { gatherClusterPanorama } from '../../src/core/concierge/index.js';
import {
  setup,
  seedClusters,
  type Ctx,
} from '../helpers/mo-topic-hygiene-setup.js';

describe('gatherClusterPanorama', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns clusters with note counts + pin flag + sample titles', () => {
    const folder = ctx.folders.create('F');
    seedClusters(ctx, folder.id, [
      { clusterId: 'big', count: 3 },
      { clusterId: 'pinned', count: 1, pinned: true },
      { clusterId: 'tiny', count: 1 },
    ]);

    const panorama = gatherClusterPanorama(ctx.handle.db, folder.id);
    const byId = new Map(panorama.map((p) => [p.clusterId, p]));

    expect(byId.get('big')?.noteCount).toBe(3);
    expect(byId.get('big')?.hasUserPin).toBe(false);
    expect(byId.get('big')?.sampleTitles.length).toBeGreaterThan(0);

    expect(byId.get('pinned')?.noteCount).toBe(1);
    expect(byId.get('pinned')?.hasUserPin).toBe(true);

    expect(byId.get('tiny')?.noteCount).toBe(1);

    // Sorted by note_count DESC.
    expect(panorama[0]?.clusterId).toBe('big');
  });

  it('isolates per-folder (Case 26)', () => {
    const a = ctx.folders.create('A');
    const b = ctx.folders.create('B');
    seedClusters(ctx, a.id, [{ clusterId: 'shared', count: 2 }]);
    seedClusters(ctx, b.id, [{ clusterId: 'shared', count: 5 }]);

    const aPanorama = gatherClusterPanorama(ctx.handle.db, a.id);
    const bPanorama = gatherClusterPanorama(ctx.handle.db, b.id);

    expect(aPanorama.find((p) => p.clusterId === 'shared')?.noteCount).toBe(2);
    expect(bPanorama.find((p) => p.clusterId === 'shared')?.noteCount).toBe(5);
  });
});

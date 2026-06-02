import { describe, it, expect, beforeEach } from 'vitest';
import { applyCleanupQuickAction } from '../../src/core/concierge/index.js';
import { longBody, setup, type Ctx } from '../helpers/mo-topic-cleanup-setup.js';

describe('applyCleanupQuickAction', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  function deps() {
    return {
      db: ctx.handle.db,
      clusters: ctx.clusters,
      clusterQueue: ctx.clusterQueue,
      decisions: ctx.decisions,
    };
  }

  it('cleanup-merge dispatches to mergeClusters and produces a friendly receipt', () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create({ body: longBody('A'), folderId: folder.id, source: 'user' }, 'user');
    const b = ctx.notes.create({ body: longBody('B'), folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'src', source: 'tier1' });
    ctx.clusters.upsert({ noteId: b.id, clusterId: 'src', source: 'tier1' });

    const receipt = applyCleanupQuickAction(deps(), {
      kind: 'cleanup-merge',
      folderId: folder.id,
      source: 'src',
      target: 'dst',
    });

    expect(receipt.decision).toBe('merged');
    expect(receipt.target).toBe('dst');
    expect(receipt.affectedNoteIds?.sort()).toEqual([a.id, b.id].sort());
    expect(receipt.summary).toMatch(/Merged 2 notes into `dst`/);
    expect(ctx.clusters.listForCluster('src')).toHaveLength(0);
    expect(ctx.decisions.get(folder.id, 'src', 'dst')?.decidedBy).toBe('user');
  });

  it('cleanup-keep records kept_separate with the right shape (target null vs string)', () => {
    const folder = ctx.folders.create('F');
    const merge = applyCleanupQuickAction(deps(), {
      kind: 'cleanup-keep',
      folderId: folder.id,
      source: 'a',
      target: 'b',
    });
    expect(merge.decision).toBe('kept_separate');
    expect(merge.target).toBe('b');
    expect(ctx.decisions.get(folder.id, 'a', 'b')?.decision).toBe('kept_separate');

    const demoteKeep = applyCleanupQuickAction(deps(), {
      kind: 'cleanup-keep',
      folderId: folder.id,
      source: 'c',
      target: null,
    });
    expect(demoteKeep.decision).toBe('kept_separate');
    expect(demoteKeep.target).toBeNull();
    expect(ctx.decisions.get(folder.id, 'c', null)?.decision).toBe('kept_separate');
  });

  it('cleanup-demote records demote_tag (tag-write path is stub for now)', () => {
    const folder = ctx.folders.create('F');
    const receipt = applyCleanupQuickAction(deps(), {
      kind: 'cleanup-demote',
      folderId: folder.id,
      source: 'user-interface',
      suggestedTag: 'ui',
    });
    expect(receipt.decision).toBe('demote_tag');
    expect(receipt.summary).toContain('user-interface');
    expect(receipt.summary).toContain('`ui`');
    expect(ctx.decisions.get(folder.id, 'user-interface', null)?.decision).toBe(
      'demote_tag',
    );
  });

  it('cleanup-bundle-merge merges every non-target topic into target in one call', () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create({ body: longBody('A'), folderId: folder.id, source: 'user' }, 'user');
    const b = ctx.notes.create({ body: longBody('B'), folderId: folder.id, source: 'user' }, 'user');
    const c = ctx.notes.create({ body: longBody('C'), folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'topic-a', source: 'tier1' });
    ctx.clusters.upsert({ noteId: b.id, clusterId: 'topic-b', source: 'tier1' });
    ctx.clusters.upsert({ noteId: c.id, clusterId: 'topic-c', source: 'tier1' });

    const receipt = applyCleanupQuickAction(deps(), {
      kind: 'cleanup-bundle-merge',
      folderId: folder.id,
      topics: ['topic-a', 'topic-b', 'topic-c'],
      target: 'topic-c',
      mergedSources: ['topic-a', 'topic-b'],
    });

    expect(receipt.decision).toBe('merged');
    expect(receipt.target).toBe('topic-c');
    expect(receipt.summary).toMatch(/Merged 2 topics into `topic-c`/);
    // Source topics emptied; target gained both notes.
    expect(ctx.clusters.listForCluster('topic-a')).toHaveLength(0);
    expect(ctx.clusters.listForCluster('topic-b')).toHaveLength(0);
    const cRows = ctx.clusters.listForCluster('topic-c');
    expect(cRows.map((r) => r.noteId).sort()).toEqual([a.id, b.id, c.id].sort());
    // Decisions recorded for both merge directions.
    expect(ctx.decisions.get(folder.id, 'topic-a', 'topic-c')?.decision).toBe('merged');
    expect(ctx.decisions.get(folder.id, 'topic-b', 'topic-c')?.decision).toBe('merged');
  });

  it('cleanup-bundle-keep records kept_separate for every directional pair', () => {
    const folder = ctx.folders.create('F');
    const receipt = applyCleanupQuickAction(deps(), {
      kind: 'cleanup-bundle-keep',
      folderId: folder.id,
      topics: ['x', 'y', 'z'],
    });
    expect(receipt.decision).toBe('kept_separate');
    expect(receipt.summary).toMatch(/Kept all 3 topics separate \(6 pair decisions/);
    // 3*2 = 6 directional pairs.
    expect(ctx.decisions.get(folder.id, 'x', 'y')?.decision).toBe('kept_separate');
    expect(ctx.decisions.get(folder.id, 'y', 'x')?.decision).toBe('kept_separate');
    expect(ctx.decisions.get(folder.id, 'z', 'x')?.decision).toBe('kept_separate');
    expect(ctx.decisions.get(folder.id, 'z', 'y')?.decision).toBe('kept_separate');
  });

  it('cleanup-bundle-merge throws on topics<2 or missing target', () => {
    const folder = ctx.folders.create('F');
    expect(() =>
      applyCleanupQuickAction(deps(), {
        kind: 'cleanup-bundle-merge',
        folderId: folder.id,
        topics: ['only-one'],
        target: 'only-one',
      }),
    ).toThrow(/topics\[≥2\]/);
    expect(() =>
      applyCleanupQuickAction(deps(), {
        kind: 'cleanup-bundle-merge',
        folderId: folder.id,
        topics: ['a', 'b'],
      }),
    ).toThrow(/target/);
  });

  it('throws on missing fields / unknown kind', () => {
    expect(() =>
      applyCleanupQuickAction(deps(), { kind: 'cleanup-merge' }),
    ).toThrow(/folderId\/source/);
    expect(() =>
      applyCleanupQuickAction(deps(), {
        kind: 'cleanup-merge',
        folderId: 'F',
        source: 'a',
      }),
    ).toThrow(/cleanup-merge requires target/);
    expect(() =>
      applyCleanupQuickAction(deps(), {
        kind: 'cleanup-bogus',
        folderId: 'F',
        source: 'a',
      }),
    ).toThrow(/unknown payload.kind/);
  });
});

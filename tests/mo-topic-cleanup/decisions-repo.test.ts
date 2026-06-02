import { describe, it, expect, beforeEach } from 'vitest';
import { setup, type Ctx } from '../helpers/mo-topic-cleanup-setup.js';

describe('MoTopicDecisionsRepository', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('records, gets, lists, forgets — round-trip', () => {
    const folder = ctx.folders.create('F');
    ctx.decisions.record({
      folderId: folder.id,
      sourceCluster: 'a',
      targetCluster: 'b',
      decision: 'merged',
      decidedBy: 'auto',
      reason: 'auto: 0.91',
    });
    ctx.decisions.record({
      folderId: folder.id,
      sourceCluster: 'c',
      targetCluster: 'd',
      decision: 'kept_separate',
      decidedBy: 'user',
    });

    expect(ctx.decisions.get(folder.id, 'a', 'b')?.decision).toBe('merged');
    expect(ctx.decisions.get(folder.id, 'c', 'd')?.decision).toBe('kept_separate');
    expect(ctx.decisions.get(folder.id, 'a', 'd')).toBeNull();
    expect(ctx.decisions.hasAnyDecisionFor(folder.id, 'a')).toBe(true);
    expect(ctx.decisions.hasAnyDecisionFor(folder.id, 'never')).toBe(false);

    expect(ctx.decisions.listForFolder(folder.id)).toHaveLength(2);

    expect(ctx.decisions.forget(folder.id, 'a', 'b')).toBe(true);
    expect(ctx.decisions.forget(folder.id, 'a', 'b')).toBe(false);
    expect(ctx.decisions.get(folder.id, 'a', 'b')).toBeNull();
  });

  it('treats demote_tag rows as targetCluster=null, round-trip preserved', () => {
    const folder = ctx.folders.create('F');
    ctx.decisions.record({
      folderId: folder.id,
      sourceCluster: 'user-interface',
      targetCluster: null,
      decision: 'demote_tag',
      decidedBy: 'user',
    });

    const row = ctx.decisions.get(folder.id, 'user-interface', null);
    expect(row?.decision).toBe('demote_tag');
    expect(row?.targetCluster).toBeNull();
  });

  it('overwrites on re-record (decisions are mutable in-place)', () => {
    const folder = ctx.folders.create('F');
    ctx.decisions.record({
      folderId: folder.id,
      sourceCluster: 'a',
      targetCluster: 'b',
      decision: 'kept_separate',
      decidedBy: 'auto',
      reason: 'low confidence',
    });
    ctx.decisions.record({
      folderId: folder.id,
      sourceCluster: 'a',
      targetCluster: 'b',
      decision: 'merged',
      decidedBy: 'user',
      reason: 'user said yes',
    });

    const row = ctx.decisions.get(folder.id, 'a', 'b');
    expect(row?.decision).toBe('merged');
    expect(row?.decidedBy).toBe('user');
    expect(row?.reason).toBe('user said yes');
  });
});

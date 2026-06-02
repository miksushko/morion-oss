import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeClusters,
  ensureClusterNote,
} from '../../src/core/concierge/index.js';
import { longBody, setup, type Ctx } from '../helpers/mo-topic-cleanup-setup.js';

describe('mergeClusters — happy path', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('reassigns assignments, dedups, soft-deletes source doc, enqueues target, records decision', () => {
    const folder = ctx.folders.create('F');

    const a = ctx.notes.create({ body: longBody('A'), folderId: folder.id, source: 'user' }, 'user');
    const b = ctx.notes.create({ body: longBody('B'), folderId: folder.id, source: 'user' }, 'user');
    const c = ctx.notes.create({ body: longBody('C'), folderId: folder.id, source: 'user' }, 'user');

    // a + b live in source `widgets`; b also already lives in target
    // `panels`. Expect:
    //   a -> panels (newly assigned)
    //   b -> panels existing row updated to max(confidence)
    //   c -> panels (newly assigned)
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'widgets', confidence: 0.85, source: 'tier1' });
    ctx.clusters.upsert({ noteId: b.id, clusterId: 'widgets', confidence: 0.6, source: 'tier1' });
    ctx.clusters.upsert({ noteId: b.id, clusterId: 'panels', confidence: 0.4, source: 'tier1' });
    ctx.clusters.upsert({ noteId: c.id, clusterId: 'widgets', confidence: 0.7, source: 'tier1' });

    // Source has an aggregator note; target doesn't yet.
    const sourceNote = ensureClusterNote(ctx.handle.db, folder.id, 'widgets');
    expect(sourceNote.created).toBe(true);

    const result = mergeClusters(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
      },
      folder.id,
      'widgets',
      'panels',
      { reason: 'auto: lexical similarity 0.92', decidedBy: 'auto' },
    );

    expect(result.status).toBe('merged');
    expect(result.affectedNoteIds.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(result.removedClusterNoteId).toBe(sourceNote.id);
    expect(result.preservedUserAssignmentIds).toEqual([]);

    // Source rows gone, target rows present with max(confidence) on the
    // pre-existing pair.
    expect(ctx.clusters.listForCluster('widgets')).toHaveLength(0);
    const panelsRows = ctx.clusters.listForCluster('panels');
    const byNote = new Map(panelsRows.map((r) => [r.noteId, r]));
    expect(byNote.get(a.id)?.confidence).toBeCloseTo(0.85, 2);
    // b was 0.6 on widgets, 0.4 on panels — should now be 0.6 (max).
    expect(byNote.get(b.id)?.confidence).toBeCloseTo(0.6, 2);
    expect(byNote.get(c.id)?.confidence).toBeCloseTo(0.7, 2);

    // Source aggregator note soft-deleted (deleted_at set), not hard-removed.
    const row = ctx.handle.db
      .prepare<[string], { deleted_at: number | null }>(
        'SELECT deleted_at FROM notes WHERE id = ?',
      )
      .get(sourceNote.id);
    expect(row?.deleted_at).not.toBeNull();

    // Target enqueued for Tier 2 regen.
    const queue = ctx.clusterQueue.listForFolder(folder.id);
    expect(queue.map((q) => q.clusterId)).toContain('panels');

    // Decision recorded.
    const decision = ctx.decisions.get(folder.id, 'widgets', 'panels');
    expect(decision?.decision).toBe('merged');
    expect(decision?.decidedBy).toBe('auto');
    expect(decision?.reason).toBe('auto: lexical similarity 0.92');
  });

  it('is idempotent — second call after success returns noop_no_assignments', () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create({ body: longBody('A'), folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'src', source: 'tier1' });

    const deps = {
      db: ctx.handle.db,
      clusters: ctx.clusters,
      clusterQueue: ctx.clusterQueue,
      decisions: ctx.decisions,
    };

    const first = mergeClusters(deps, folder.id, 'src', 'dst');
    expect(first.status).toBe('merged');

    const second = mergeClusters(deps, folder.id, 'src', 'dst');
    expect(second.status).toBe('noop_no_assignments');
    expect(second.affectedNoteIds).toEqual([]);
  });
});

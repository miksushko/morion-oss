import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeClusters,
  ensureClusterNote,
} from '../../src/core/concierge/index.js';
import { longBody, setup, type Ctx } from '../helpers/mo-topic-cleanup-setup.js';

describe('mergeClusters — protections', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('refuses when prior decision is kept_separate', () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create({ body: longBody('A'), folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'src', source: 'tier1' });

    ctx.decisions.record({
      folderId: folder.id,
      sourceCluster: 'src',
      targetCluster: 'dst',
      decision: 'kept_separate',
      decidedBy: 'user',
    });

    const result = mergeClusters(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
      },
      folder.id,
      'src',
      'dst',
    );

    expect(result.status).toBe('noop_already_decided');
    // Source assignment untouched.
    expect(ctx.clusters.listForCluster('src')).toHaveLength(1);
  });

  it('preserves user-pinned source assignments and reassigns the rest', () => {
    const folder = ctx.folders.create('F');
    const userPinned = ctx.notes.create({ body: longBody('UP'), folderId: folder.id, source: 'user' }, 'user');
    const tier1Auto = ctx.notes.create({ body: longBody('T1'), folderId: folder.id, source: 'user' }, 'user');

    ctx.clusters.upsert({ noteId: userPinned.id, clusterId: 'src', source: 'user', confidence: 1.0 });
    ctx.clusters.upsert({ noteId: tier1Auto.id, clusterId: 'src', source: 'tier1', confidence: 0.8 });

    const sourceNote = ensureClusterNote(ctx.handle.db, folder.id, 'src');

    const result = mergeClusters(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
      },
      folder.id,
      'src',
      'dst',
    );

    expect(result.status).toBe('merged');
    expect(result.affectedNoteIds).toEqual([tier1Auto.id]);
    expect(result.preservedUserAssignmentIds).toEqual([userPinned.id]);

    // user-pinned row STAYS on source; tier1 row moved to dst.
    const srcRows = ctx.clusters.listForCluster('src');
    expect(srcRows.map((r) => r.noteId)).toEqual([userPinned.id]);
    const dstRows = ctx.clusters.listForCluster('dst');
    expect(dstRows.map((r) => r.noteId)).toEqual([tier1Auto.id]);

    // Source aggregator note NOT deleted — it still has notes attached.
    const row = ctx.handle.db
      .prepare<[string], { deleted_at: number | null }>(
        'SELECT deleted_at FROM notes WHERE id = ?',
      )
      .get(sourceNote.id);
    expect(row?.deleted_at).toBeNull();
    expect(result.removedClusterNoteId).toBeNull();

    // Both target AND source enqueued for Tier 2 regen — source's
    // aggregator doc is now stale (it lost tier1Auto's note) and
    // needs to refresh against the trimmed user-pinned set (Codex
    // finding 2026-05-03).
    const queued = ctx.clusterQueue.listForFolder(folder.id);
    const queuedIds = queued.map((q) => q.clusterId).sort();
    expect(queuedIds).toContain('dst');
    expect(queuedIds).toContain('src');
  });

  it('does NOT enqueue source when no user pins remain (full reassignment)', () => {
    // Counterpart to the previous test: with zero preserved rows, the
    // source doc gets soft-deleted in step 4, so enqueueing it for
    // Tier 2 would be wasted work.
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create({ body: longBody('A'), folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'src', source: 'tier1' });
    ensureClusterNote(ctx.handle.db, folder.id, 'src');

    mergeClusters(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
      },
      folder.id,
      'src',
      'dst',
    );

    const queued = ctx.clusterQueue.listForFolder(folder.id);
    const queuedIds = queued.map((q) => q.clusterId).sort();
    expect(queuedIds).toContain('dst');
    expect(queuedIds).not.toContain('src');
  });

  it('full user-pin folder is a no-op recorded as kept_separate', () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create({ body: longBody('A'), folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'src', source: 'user' });

    const result = mergeClusters(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
      },
      folder.id,
      'src',
      'dst',
    );

    expect(result.status).toBe('noop_user_protected');
    expect(result.preservedUserAssignmentIds).toEqual([a.id]);

    // Decision recorded so the proposer doesn't keep re-asking.
    const decision = ctx.decisions.get(folder.id, 'src', 'dst');
    expect(decision?.decision).toBe('kept_separate');
    expect(decision?.decidedBy).toBe('auto');
  });

  it('source equals target is a no-op (defensive)', () => {
    const folder = ctx.folders.create('F');
    const result = mergeClusters(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
      },
      folder.id,
      'same',
      'same',
    );
    expect(result.status).toBe('noop_no_assignments');
  });
});

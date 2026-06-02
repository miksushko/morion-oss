import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeClusters,
  ensureClusterNote,
  findClusterNoteId,
} from '../../src/core/concierge/index.js';
import { longBody, setup, type Ctx } from '../helpers/mo-topic-cleanup-setup.js';

describe('mergeClusters — folder isolation (Case 26)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('does not touch a same-named cluster in another folder', () => {
    const folderA = ctx.folders.create('A');
    const folderB = ctx.folders.create('B');

    const noteA = ctx.notes.create({ body: longBody('A'), folderId: folderA.id, source: 'user' }, 'user');
    const noteB = ctx.notes.create({ body: longBody('B'), folderId: folderB.id, source: 'user' }, 'user');

    ctx.clusters.upsert({ noteId: noteA.id, clusterId: 'shared', source: 'tier1' });
    ctx.clusters.upsert({ noteId: noteB.id, clusterId: 'shared', source: 'tier1' });

    // Each folder also has its own aggregator note for `shared`.
    const sourceNoteA = ensureClusterNote(ctx.handle.db, folderA.id, 'shared');
    const sourceNoteB = ensureClusterNote(ctx.handle.db, folderB.id, 'shared');

    // Merge `shared -> moved` only in folderA.
    const result = mergeClusters(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
      },
      folderA.id,
      'shared',
      'moved',
    );

    expect(result.status).toBe('merged');
    expect(result.affectedNoteIds).toEqual([noteA.id]);

    // folderB's `shared` cluster row + aggregator note are intact.
    const sharedRows = ctx.clusters.listForCluster('shared');
    expect(sharedRows.map((r) => r.noteId)).toEqual([noteB.id]);

    const aRow = ctx.handle.db
      .prepare<[string], { deleted_at: number | null }>(
        'SELECT deleted_at FROM notes WHERE id = ?',
      )
      .get(sourceNoteA.id);
    const bRow = ctx.handle.db
      .prepare<[string], { deleted_at: number | null }>(
        'SELECT deleted_at FROM notes WHERE id = ?',
      )
      .get(sourceNoteB.id);
    expect(aRow?.deleted_at).not.toBeNull();
    expect(bRow?.deleted_at).toBeNull();

    // Decision row is per-folder.
    expect(ctx.decisions.get(folderA.id, 'shared', 'moved')?.decision).toBe('merged');
    expect(ctx.decisions.get(folderB.id, 'shared', 'moved')).toBeNull();

    // Cluster queue enqueue scoped to folderA.
    expect(
      ctx.clusterQueue.listForFolder(folderA.id).some((q) => q.clusterId === 'moved'),
    ).toBe(true);
    expect(
      ctx.clusterQueue.listForFolder(folderB.id).some((q) => q.clusterId === 'moved'),
    ).toBe(false);

    // findClusterNoteId per-folder lookup confirms folderA's source
    // doc is gone (soft-deleted) but folderB's still resolves.
    expect(findClusterNoteId(ctx.handle.db, folderA.id, 'shared')).toBeNull();
    expect(findClusterNoteId(ctx.handle.db, folderB.id, 'shared')).toBe(sourceNoteB.id);
  });
});

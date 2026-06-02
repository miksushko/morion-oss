import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import {
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  MoMetadataQueueRepository,
  MoClusterQueueRepository,
} from '../src/core/concierge/index.js';

/**
 * Mo Indexing Redesign Phase 1 — repository contracts.
 *
 * Pin the four foundation tables from migration 0017:
 *  - note_mo_metadata (per-note cache)
 *  - note_mo_clusters (many-to-many JOIN)
 *  - mo_metadata_queue (per-note dirty queue with coalescing)
 *  - mo_cluster_queue (per-cluster regen queue)
 */

interface Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  noteQueue: MoMetadataQueueRepository;
  clusterQueue: MoClusterQueueRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  return {
    handle,
    audit,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
    meta: new NoteMoMetadataRepository(handle.db),
    clusters: new NoteMoClustersRepository(handle.db),
    noteQueue: new MoMetadataQueueRepository(handle.db),
    clusterQueue: new MoClusterQueueRepository(handle.db),
  };
}

describe('NoteMoMetadataRepository', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('upsert creates a fresh row and round-trips fields', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# Hello\n\nworld', folderId: folder.id, source: 'user' },
      'user',
    );

    const meta = ctx.meta.upsert({
      noteId: note.id,
      summary: 'Hello world note',
      keywords: ['hello', 'world'],
      bodyHash: 'abc123',
      computedBy: 'tier1',
      computedAt: 1000,
      confidence: 0.9,
    });

    expect(meta.summary).toBe('Hello world note');
    expect(meta.keywords).toEqual(['hello', 'world']);
    expect(meta.bodyHash).toBe('abc123');
    expect(meta.computedBy).toBe('tier1');
    expect(meta.confidence).toBe(0.9);
    expect(meta.moHandsOff).toBe(false);

    const reread = ctx.meta.get(note.id);
    expect(reread).not.toBeNull();
    expect(reread!.summary).toBe('Hello world note');
    expect(reread!.keywords).toEqual(['hello', 'world']);
  });

  it('upsert preserves existing fields when a partial payload is provided', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');

    ctx.meta.upsert({
      noteId: note.id,
      summary: 'first',
      keywords: ['k1', 'k2'],
      bodyHash: 'h1',
      computedBy: 'tier1',
      computedAt: 1,
      confidence: 0.5,
    });
    // Second upsert only overwrites summary; other fields must persist.
    ctx.meta.upsert({ noteId: note.id, summary: 'second' });

    const got = ctx.meta.get(note.id);
    expect(got!.summary).toBe('second');
    expect(got!.keywords).toEqual(['k1', 'k2']);
    expect(got!.bodyHash).toBe('h1');
    expect(got!.computedBy).toBe('tier1');
    expect(got!.confidence).toBe(0.5);
  });

  it('isFresh returns true on hash match, false otherwise', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    ctx.meta.upsert({ noteId: note.id, bodyHash: 'h1' });
    expect(ctx.meta.isFresh(note.id, 'h1')).toBe(true);
    expect(ctx.meta.isFresh(note.id, 'h2')).toBe(false);
    expect(ctx.meta.isFresh('does-not-exist', 'h1')).toBe(false);
  });

  it('setHandsOff toggles the opt-out flag', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    ctx.meta.setHandsOff(note.id, true);
    expect(ctx.meta.get(note.id)!.moHandsOff).toBe(true);
    ctx.meta.setHandsOff(note.id, false);
    expect(ctx.meta.get(note.id)!.moHandsOff).toBe(false);
  });

  it('CASCADE deletes metadata when the note is hard-deleted', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    ctx.meta.upsert({ noteId: note.id, summary: 'x' });
    ctx.handle.db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
    expect(ctx.meta.get(note.id)).toBeNull();
  });

  it('does NOT bump notes.updated_at on metadata write (feedback-loop guard)', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    const noteBefore = ctx.notes.getById(note.id)!;
    // Wait long enough that any stray bump would be observable.
    const before = noteBefore.updatedAt;
    ctx.meta.upsert({
      noteId: note.id,
      summary: 's',
      keywords: ['k'],
      bodyHash: 'h',
      computedBy: 'tier1',
      computedAt: before + 1_000_000,
      confidence: 0.7,
    });
    const noteAfter = ctx.notes.getById(note.id)!;
    expect(noteAfter.updatedAt).toBe(before);
  });
});

describe('NoteMoClustersRepository — many-to-many', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('one note can be assigned to multiple clusters simultaneously', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');

    ctx.clusters.upsert({ noteId: note.id, clusterId: 'mo-chat-loop', source: 'tier1' });
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'mcp-surface', source: 'tier1' });
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'infra-bugs', source: 'user' });

    const got = ctx.clusters.listForNote(note.id);
    expect(got).toHaveLength(3);
    expect(got.map((c) => c.clusterId).sort()).toEqual([
      'infra-bugs',
      'mcp-surface',
      'mo-chat-loop',
    ]);
    const userRow = got.find((c) => c.source === 'user');
    expect(userRow?.confidence).toBe(1.0); // user defaults to 1.0
  });

  it('upsert on existing pair updates confidence + source + updated_at', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert(
      { noteId: note.id, clusterId: 'kanban-ui', confidence: 0.6, source: 'tier1' },
      1000,
    );
    ctx.clusters.upsert(
      { noteId: note.id, clusterId: 'kanban-ui', confidence: 0.95, source: 'verified' },
      2000,
    );
    const got = ctx.clusters.listForNote(note.id);
    expect(got).toHaveLength(1);
    expect(got[0]!.confidence).toBe(0.95);
    expect(got[0]!.source).toBe('verified');
    expect(got[0]!.updatedAt).toBe(2000);
  });

  it('noteIdsInClusters returns distinct note ids across multiple clusters', () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    const b = ctx.notes.create({ body: '# B', folderId: folder.id, source: 'user' }, 'user');
    const c = ctx.notes.create({ body: '# C', folderId: folder.id, source: 'user' }, 'user');

    ctx.clusters.upsert({ noteId: a.id, clusterId: 'kanban-ui', source: 'tier1' });
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'mo-chat-loop', source: 'tier1' });
    ctx.clusters.upsert({ noteId: b.id, clusterId: 'kanban-ui', source: 'tier1' });
    ctx.clusters.upsert({ noteId: c.id, clusterId: 'unrelated', source: 'tier1' });

    const ids = ctx.clusters.noteIdsInClusters(['kanban-ui', 'mo-chat-loop']);
    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });

  it('replaceForNote with preserveUserOverrides keeps source=user rows', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');

    ctx.clusters.upsert({ noteId: note.id, clusterId: 'kept', source: 'user' });
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'replaced-1', source: 'tier1' });
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'replaced-2', source: 'tier1' });

    ctx.clusters.replaceForNote(
      note.id,
      [{ clusterId: 'fresh', source: 'tier1' }],
      { preserveUserOverrides: true },
    );

    const got = ctx.clusters.listForNote(note.id);
    expect(got.map((c) => c.clusterId).sort()).toEqual(['fresh', 'kept']);
  });

  it('renameCluster bulk-updates every assignment', () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    const b = ctx.notes.create({ body: '# B', folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'kanban-ui', source: 'tier1' });
    ctx.clusters.upsert({ noteId: b.id, clusterId: 'kanban-ui', source: 'tier1' });

    const changed = ctx.clusters.renameCluster('kanban-ui', 'board-ui');
    expect(changed).toBe(2);
    expect(ctx.clusters.listForCluster('kanban-ui')).toHaveLength(0);
    expect(ctx.clusters.listForCluster('board-ui')).toHaveLength(2);
  });

  it('CASCADE deletes assignments when the note is hard-deleted', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'x', source: 'tier1' });
    ctx.handle.db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
    expect(ctx.clusters.listForNote(note.id)).toHaveLength(0);
  });
});

describe('MoMetadataQueueRepository — coalescing + claim', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('enqueue with coalescing collapses repeated dirty signals to one row', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');

    ctx.noteQueue.enqueue(folder.id, note.id, 'tier1', 'h1', 1000);
    ctx.noteQueue.enqueue(folder.id, note.id, 'tier1', 'h2', 2000);
    ctx.noteQueue.enqueue(folder.id, note.id, 'tier1', 'h3', 3000);

    const rows = ctx.noteQueue.listForFolder(folder.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bodyHash).toBe('h3');
    expect(rows[0]!.dirtySince).toBe(3000);
  });

  it('different tiers do NOT coalesce — same note can have separate rows for tier0 and tier1', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    ctx.noteQueue.enqueue(folder.id, note.id, 'tier0', 'h1', 1000);
    ctx.noteQueue.enqueue(folder.id, note.id, 'tier1', 'h1', 1000);
    expect(ctx.noteQueue.listForFolder(folder.id)).toHaveLength(2);
  });

  it('claim stamps picked_at and respects limit + tier filter', () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    const b = ctx.notes.create({ body: '# B', folderId: folder.id, source: 'user' }, 'user');
    const c = ctx.notes.create({ body: '# C', folderId: folder.id, source: 'user' }, 'user');

    ctx.noteQueue.enqueue(folder.id, a.id, 'tier1', 'ha', 1000);
    ctx.noteQueue.enqueue(folder.id, b.id, 'tier1', 'hb', 2000);
    ctx.noteQueue.enqueue(folder.id, c.id, 'tier0', 'hc', 1500);

    const claimed = ctx.noteQueue.claim('tier1', 10, 5000);
    expect(claimed).toHaveLength(2);
    // Oldest first.
    expect(claimed[0]!.noteId).toBe(a.id);
    expect(claimed[1]!.noteId).toBe(b.id);
    expect(claimed[0]!.pickedAt).toBe(5000);

    // Already-claimed rows shouldn't reappear.
    const second = ctx.noteQueue.claim('tier1', 10, 6000);
    expect(second).toHaveLength(0);
  });

  it('release returns a row to the available pool and bumps attempts', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    ctx.noteQueue.enqueue(folder.id, note.id, 'tier1', 'h', 1000);
    ctx.noteQueue.claim('tier1', 1, 2000);
    ctx.noteQueue.release(folder.id, note.id, 'tier1');

    const second = ctx.noteQueue.claim('tier1', 1, 3000);
    expect(second).toHaveLength(1);
    expect(second[0]!.attempts).toBe(1);
  });

  it('complete removes the row from the queue', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    ctx.noteQueue.enqueue(folder.id, note.id, 'tier1', 'h', 1000);
    ctx.noteQueue.claim('tier1', 1, 2000);
    ctx.noteQueue.complete(folder.id, note.id, 'tier1');
    expect(ctx.noteQueue.listForFolder(folder.id)).toHaveLength(0);
  });

  it('CASCADE deletes queue rows when the folder is hard-deleted', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    ctx.noteQueue.enqueue(folder.id, note.id, 'tier1', 'h', 1000);
    ctx.handle.db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
    expect(ctx.noteQueue.listForFolder(folder.id)).toHaveLength(0);
  });
});

describe('MoClusterQueueRepository', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('coalescing on (folder_id, cluster_id) refreshes dirty_since', () => {
    const folder = ctx.folders.create('F');
    ctx.clusterQueue.enqueue(folder.id, 'kanban-ui', 1000);
    ctx.clusterQueue.enqueue(folder.id, 'kanban-ui', 2000);
    ctx.clusterQueue.enqueue(folder.id, 'kanban-ui', 3000);
    const rows = ctx.clusterQueue.listForFolder(folder.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dirtySince).toBe(3000);
  });

  it('claim respects olderThan threshold for debouncing', () => {
    const folder = ctx.folders.create('F');
    ctx.clusterQueue.enqueue(folder.id, 'fresh', 5000);   // too recent
    ctx.clusterQueue.enqueue(folder.id, 'aged', 1000);    // old enough
    const claimed = ctx.clusterQueue.claim(/* olderThan */ 3000, 10, 6000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.clusterId).toBe('aged');
  });
});

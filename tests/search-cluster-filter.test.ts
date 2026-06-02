import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import { NoteMoClustersRepository } from '../src/core/concierge/index.js';

/**
 * Phase 5a — `SearchOptions.cluster` filter on HybridSearch.
 * Joins through `note_mo_clusters` so a search query restricts to
 * notes assigned to any of the supplied cluster ids.
 */

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  search: HybridSearch;
  clusters: NoteMoClustersRepository;
  indexer: Indexer;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  return {
    handle,
    notes,
    folders,
    search: new HybridSearch(handle.db, fts, vec, embeddings),
    clusters: new NoteMoClustersRepository(handle.db),
    indexer: new Indexer(vec, embeddings),
  };
}

describe('HybridSearch.search — cluster filter', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('restricts results to notes assigned to a single cluster id', async () => {
    const folder = ctx.folders.create('F');
    const inCluster = ctx.notes.create(
      {
        body: '# Tier 2 cluster bug\n\nWKWebView dragstart needs setData()',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    const outOfCluster = ctx.notes.create(
      {
        body: '# Unrelated note\n\nWKWebView dragstart needs setData()',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    ctx.clusters.upsert({
      noteId: inCluster.id,
      clusterId: 'kanban-ui',
      source: 'tier1',
    });

    const hits = await ctx.search.search('WKWebView dragstart', {
      cluster: 'kanban-ui',
      limit: 10,
    });
    const ids = hits.map((h) => h.note.id);
    expect(ids).toContain(inCluster.id);
    expect(ids).not.toContain(outOfCluster.id);
  });

  it('supports multiple cluster ids (many-to-many; ANY match wins)', async () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create(
      { body: '# A WKWebView A', folderId: folder.id, source: 'user' },
      'user',
    );
    const b = ctx.notes.create(
      { body: '# B WKWebView B', folderId: folder.id, source: 'user' },
      'user',
    );
    const c = ctx.notes.create(
      { body: '# C WKWebView C', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'kanban-ui', source: 'tier1' });
    ctx.clusters.upsert({ noteId: b.id, clusterId: 'mo-chat-loop', source: 'tier1' });
    ctx.clusters.upsert({ noteId: c.id, clusterId: 'unrelated', source: 'tier1' });

    const hits = await ctx.search.search('WKWebView', {
      cluster: ['kanban-ui', 'mo-chat-loop'],
      limit: 10,
    });
    const ids = hits.map((h) => h.note.id).sort();
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(c.id);
  });

  it('a note with multiple cluster assignments matches if ANY is in the filter', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# Cross-cutting WKWebView ticket', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'mo-chat-loop', source: 'tier1' });
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'mcp-surface', source: 'tier1' });

    const hits = await ctx.search.search('WKWebView', {
      cluster: ['mcp-surface'],
      limit: 10,
    });
    expect(hits.map((h) => h.note.id)).toContain(note.id);
  });

  it('empty array short-circuits to zero hits without bogus SQL', async () => {
    const folder = ctx.folders.create('F');
    ctx.notes.create(
      { body: '# Anything WKWebView', folderId: folder.id, source: 'user' },
      'user',
    );
    const hits = await ctx.search.search('WKWebView', {
      cluster: [],
      limit: 10,
    });
    expect(hits).toHaveLength(0);
  });

  it('cluster filter composes with folderId + tag filters', async () => {
    const f1 = ctx.folders.create('F1');
    const f2 = ctx.folders.create('F2');
    const a = ctx.notes.create(
      {
        body: '# In folder 1 WKWebView',
        folderId: f1.id,
        source: 'user',
        tags: ['lesson'],
      },
      'user',
    );
    const b = ctx.notes.create(
      {
        body: '# In folder 2 WKWebView',
        folderId: f2.id,
        source: 'user',
        tags: ['lesson'],
      },
      'user',
    );
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'kanban-ui', source: 'tier1' });
    ctx.clusters.upsert({ noteId: b.id, clusterId: 'kanban-ui', source: 'tier1' });

    const hits = await ctx.search.search('WKWebView', {
      cluster: 'kanban-ui',
      folderId: f1.id,
      limit: 10,
    });
    expect(hits.map((h) => h.note.id)).toEqual([a.id]);
  });

  it('archived notes are still excluded under cluster filter (CLAUDE.md invariant)', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# Archived WKWebView ticket', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'cx', source: 'tier1' });
    ctx.handle.db
      .prepare('UPDATE notes SET archived_at = ? WHERE id = ?')
      .run(Date.now(), note.id);

    const hits = await ctx.search.search('WKWebView', {
      cluster: 'cx',
      limit: 10,
    });
    expect(hits).toHaveLength(0);
  });
});

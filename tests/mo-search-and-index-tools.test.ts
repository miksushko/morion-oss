import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { RevisionsRepository } from '../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import { NoteCommentsRepository } from '../src/core/notes/comments-repository.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import {
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  MoSpendLedgerRepository,
  MoMemoryRepository,
  BudgetTracker,
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  ensureCatalogNote,
  mergeCatalogDoc,
  renderCatalogSection,
} from '../src/core/concierge/index.js';
import { moSearchTool } from '../src/server/tools/mo/mo_search.js';
import type { ToolContext } from '../src/server/tools/types.js';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  toolCtx: ToolContext;
}

function setup(opts?: { isPro?: boolean; moEnabledFolderId?: string }): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const revisions = new RevisionsRepository(handle.db);
  const attachments = new AttachmentsRepository(handle.db);
  const comments = new NoteCommentsRepository(handle.db);
  const settings = new SettingsRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const search = new HybridSearch(handle.db, fts, vec, embeddings);
  const indexer = new Indexer(vec, embeddings);
  const meta = new NoteMoMetadataRepository(handle.db);
  const clusters = new NoteMoClustersRepository(handle.db);

  const concierge = {
    folderSettings: new ConciergeFolderSettingsRepository(handle.db),
    sessions: new ConciergeSessionsRepository(handle.db),
    messages: new ConciergeMessagesRepository(handle.db),
    moSpendLedger: new MoSpendLedgerRepository(handle.db),
    moMemory: new MoMemoryRepository(settings),
    budget: new BudgetTracker(new MoSpendLedgerRepository(handle.db)),
    moMetadata: meta,
    moClusters: clusters,
  };

  if (opts?.moEnabledFolderId) {
    concierge.folderSettings.update(opts.moEnabledFolderId, { enabled: true });
  }

  const configDir = mkdtempSync(join(tmpdir(), 'morion-mo-tools-'));
  const toolCtx: ToolContext = {
    db: handle.db,
    notes,
    folders,
    tags,
    revisions,
    attachments,
    comments,
    search,
    indexer,
    audit,
    settings,
    actor: 'mcp:test',
    configDir,
    concierge,
  };

  return { handle, notes, folders, meta, clusters, toolCtx };
}

describe('mo_search — gates + filters', () => {
  it('returns hits with cluster assignments when Pro + Mo enabled', async () => {
    const ctxBuilder = setup({ isPro: true });
    const folder = ctxBuilder.folders.create('Search');
    ctxBuilder.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });

    const a = ctxBuilder.notes.create(
      {
        body: '# WKWebView dragstart bug\n\nDetails about WKWebView.',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    const b = ctxBuilder.notes.create(
      {
        body: '# Unrelated WKWebView ticket\n\nSomething else.',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    ctxBuilder.clusters.upsert({
      noteId: a.id,
      clusterId: 'kanban-ui',
      source: 'tier1',
    });
    ctxBuilder.clusters.upsert({
      noteId: a.id,
      clusterId: 'mcp-surface',
      source: 'tier1',
    });
    ctxBuilder.clusters.upsert({
      noteId: b.id,
      clusterId: 'unrelated',
      source: 'tier1',
    });

    const result = (await moSearchTool.handler(
      { query: 'WKWebView', folderId: folder.id, cluster: 'kanban-ui' },
      ctxBuilder.toolCtx,
    )) as {
      hits: Array<{ noteId: string; clusters: string[] }>;
      requestedClusters: string[] | null;
    };
    expect(result.requestedClusters).toEqual(['kanban-ui']);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.noteId).toBe(a.id);
    expect(result.hits[0]?.clusters.sort()).toEqual([
      'kanban-ui',
      'mcp-surface',
    ]);
  });

  it('returns helpful hint when no hits match', async () => {
    const ctxBuilder = setup({ isPro: true });
    const folder = ctxBuilder.folders.create('Empty');
    ctxBuilder.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });

    const result = (await moSearchTool.handler(
      { query: 'nonexistent', folderId: folder.id, cluster: 'no-such-cluster' },
      ctxBuilder.toolCtx,
    )) as { hits: unknown[]; hint: string | null };
    expect(result.hits).toHaveLength(0);
    expect(result.hint).toContain('mo_list_clusters');
  });

  it('default response carries Mo metadata (summary + keywords) when indexed', async () => {
    const ctxBuilder = setup({ isPro: true });
    const folder = ctxBuilder.folders.create('Indexed');
    ctxBuilder.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });

    const indexed = ctxBuilder.notes.create(
      { body: '# WKWebView indexed note\n\nBody.', folderId: folder.id, source: 'user' },
      'user',
    );
    const unindexed = ctxBuilder.notes.create(
      { body: '# WKWebView unindexed note', folderId: folder.id, source: 'user' },
      'user',
    );
    ctxBuilder.meta.upsert({
      noteId: indexed.id,
      summary: 'A WKWebView dragstart bug surfacing on Tauri macOS only.',
      keywords: ['wkwebview', 'dragstart', 'tauri', 'macos'],
      computedBy: 'tier1',
    });

    const result = (await moSearchTool.handler(
      { query: 'WKWebView', folderId: folder.id },
      ctxBuilder.toolCtx,
    )) as {
      hits: Array<{
        noteId: string;
        summary: string | null;
        keywords: string[] | null;
      }>;
    };

    const indexedHit = result.hits.find((h) => h.noteId === indexed.id);
    const unindexedHit = result.hits.find((h) => h.noteId === unindexed.id);
    expect(indexedHit?.summary).toContain('WKWebView dragstart');
    expect(indexedHit?.keywords).toEqual(['wkwebview', 'dragstart', 'tauri', 'macos']);
    expect(unindexedHit?.summary).toBeNull();
    expect(unindexedHit?.keywords).toBeNull();
  });

  it('withMetadata: false drops summary + keywords from the hit shape', async () => {
    const ctxBuilder = setup({ isPro: true });
    const folder = ctxBuilder.folders.create('Slim');
    ctxBuilder.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });

    const note = ctxBuilder.notes.create(
      { body: '# WKWebView slim', folderId: folder.id, source: 'user' },
      'user',
    );
    ctxBuilder.meta.upsert({
      noteId: note.id,
      summary: 'should not surface',
      keywords: ['hidden'],
      computedBy: 'tier1',
    });

    const result = (await moSearchTool.handler(
      { query: 'WKWebView', folderId: folder.id, withMetadata: false },
      ctxBuilder.toolCtx,
    )) as { hits: Array<Record<string, unknown>> };

    expect(result.hits[0]).not.toHaveProperty('summary');
    expect(result.hits[0]).not.toHaveProperty('keywords');
  });

  it('multiple cluster ids — many-to-many across the folder', async () => {
    const ctxBuilder = setup({ isPro: true });
    const folder = ctxBuilder.folders.create('Multi');
    ctxBuilder.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });

    const a = ctxBuilder.notes.create(
      { body: '# A WKWebView A', folderId: folder.id, source: 'user' },
      'user',
    );
    const b = ctxBuilder.notes.create(
      { body: '# B WKWebView B', folderId: folder.id, source: 'user' },
      'user',
    );
    const c = ctxBuilder.notes.create(
      { body: '# C WKWebView C', folderId: folder.id, source: 'user' },
      'user',
    );
    ctxBuilder.clusters.upsert({ noteId: a.id, clusterId: 'cluster-a', source: 'tier1' });
    ctxBuilder.clusters.upsert({ noteId: b.id, clusterId: 'cluster-b', source: 'tier1' });
    ctxBuilder.clusters.upsert({ noteId: c.id, clusterId: 'cluster-c', source: 'tier1' });

    const result = (await moSearchTool.handler(
      {
        query: 'WKWebView',
        folderId: folder.id,
        cluster: ['cluster-a', 'cluster-b'],
      },
      ctxBuilder.toolCtx,
    )) as { hits: Array<{ noteId: string }> };
    const ids = result.hits.map((h) => h.noteId).sort();
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(c.id);
  });
});

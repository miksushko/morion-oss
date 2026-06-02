import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { RevisionsRepository } from '../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import { NoteCommentsRepository } from '../src/core/notes/comments-repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import {
  MoSpendLedgerRepository,
  MoMemoryRepository,
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  BudgetTracker,
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  MoMetadataQueueRepository,
  MoClusterQueueRepository,
} from '../src/core/concierge/index.js';
import { buildHttpApp } from '../src/server/bootstrap/http.js';

/**
 * Phase 6.5 — `GET /api/notes/:id/metadata`
 *               + `PATCH /api/notes/:id/metadata`
 *               + `PUT  /api/notes/:id/clusters`
 *
 * The Meta Data tab needs a read-the-shape endpoint plus two write
 * paths: toggle the `mo_hands_off` flag and replace the user-owned
 * cluster set (mirrors `mo_reclassify` MCP tool).
 */

function activatePro(_settings: SettingsRepository): void {
  // no-op: open-source build has no license tier (kept for call-site compatibility)
}

interface Ctx {
  handle: DbHandle;
  app: ReturnType<typeof buildHttpApp>;
  settings: SettingsRepository;
  folders: FoldersRepository;
  notes: NotesRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  clusterQueue: MoClusterQueueRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const revisions = new RevisionsRepository(handle.db);
  const attachments = new AttachmentsRepository(handle.db);
  const comments = new NoteCommentsRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const search = new HybridSearch(handle.db, fts, vec, embeddings);
  const indexer = new Indexer(vec, embeddings);
  const settings = new SettingsRepository(handle.db);
  const configDir = mkdtempSync(join(tmpdir(), 'morion-note-meta-route-'));

  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const sessions = new ConciergeSessionsRepository(handle.db);
  const cMessages = new ConciergeMessagesRepository(handle.db);
  const moSpendLedger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(moSpendLedger);
  const meta = new NoteMoMetadataRepository(handle.db);
  const clusters = new NoteMoClustersRepository(handle.db);
  const metadataQueue = new MoMetadataQueueRepository(handle.db);
  const clusterQueue = new MoClusterQueueRepository(handle.db);

  const app = buildHttpApp({
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
    configDir,
    concierge: {
      folderSettings,
      sessions,
      messages: cMessages,
      moSpendLedger,
      moMemory,
      budget,
      moMetadata: meta,
      moClusters: clusters,
      moMetadataQueue: metadataQueue,
      moClusterQueue: clusterQueue,
    },
  });

  return { handle, app, settings, folders, notes, meta, clusters, clusterQueue };
}

describe('GET /api/notes/:id/metadata', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('404 for unknown note', async () => {
    const res = await ctx.app.request('/api/notes/missing/metadata');
    expect(res.status).toBe(404);
  });

  it('returns null metadata + empty clusters on a fresh note', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user' },
      'user',
    );
    const res = await ctx.app.request(`/api/notes/${note.id}/metadata`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      noteId: string;
      metadata: unknown;
      clusters: unknown[];
    };
    expect(body.noteId).toBe(note.id);
    expect(body.metadata).toBeNull();
    expect(body.clusters).toEqual([]);
  });

  it('returns metadata + clusters when populated', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: note.id,
      summary: 'Short note about widgets.',
      keywords: ['widgets', 'kanban'],
      bodyHash: 'abc',
      computedBy: 'tier1',
      computedAt: 1234,
      confidence: 0.82,
    });
    ctx.clusters.upsert({
      noteId: note.id,
      clusterId: 'kanban-ui',
      source: 'tier1',
    });
    const res = await ctx.app.request(`/api/notes/${note.id}/metadata`);
    const body = (await res.json()) as {
      metadata: { summary: string; keywords: string[]; moHandsOff: boolean };
      clusters: Array<{ clusterId: string; source: string }>;
    };
    expect(body.metadata.summary).toContain('widgets');
    expect(body.metadata.keywords).toEqual(['widgets', 'kanban']);
    expect(body.metadata.moHandsOff).toBe(false);
    expect(body.clusters).toHaveLength(1);
    expect(body.clusters[0]!.clusterId).toBe('kanban-ui');
  });
});

describe('PATCH /api/notes/:id/metadata', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('Pro toggle moHandsOff persists + auto-creates the metadata row', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user' },
      'user',
    );
    const res = await ctx.app.request(`/api/notes/${note.id}/metadata`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moHandsOff: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata: { moHandsOff: boolean };
    };
    expect(body.metadata.moHandsOff).toBe(true);
    expect(ctx.meta.get(note.id)?.moHandsOff).toBe(true);
  });

  it('Pro user can override summary; row tagged computedBy=user', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user' },
      'user',
    );
    const res = await ctx.app.request(`/api/notes/${note.id}/metadata`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'User-written summary.' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata: { summary: string; computedBy: string; confidence: number };
    };
    expect(body.metadata.summary).toBe('User-written summary.');
    expect(body.metadata.computedBy).toBe('user');
    expect(body.metadata.confidence).toBe(1);
  });

  it('Pro user can override keywords; row tagged computedBy=user', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user' },
      'user',
    );
    const res = await ctx.app.request(`/api/notes/${note.id}/metadata`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: ['alpha', 'beta'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata: { keywords: string[]; computedBy: string };
    };
    expect(body.metadata.keywords).toEqual(['alpha', 'beta']);
    expect(body.metadata.computedBy).toBe('user');
  });

  it('rejects truly unknown fields with 400 (zod strict)', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user' },
      'user',
    );
    const res = await ctx.app.request(`/api/notes/${note.id}/metadata`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // bodyHash is Mo-owned — only summary/keywords/moHandsOff legal.
      body: JSON.stringify({ bodyHash: 'attempt-to-overwrite' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/notes/:id/clusters', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('Pro PUT replaces cluster set with source=user, enqueues touched clusters for Tier 2', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user' },
      'user',
    );
    // Pre-existing tier1 row that will be replaced by the user PUT.
    ctx.clusters.upsert({
      noteId: note.id,
      clusterId: 'old-cluster',
      source: 'tier1',
    });
    const res = await ctx.app.request(`/api/notes/${note.id}/clusters`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clusters: ['new-cluster', 'another'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clusters: Array<{ clusterId: string; source: string }>;
    };
    expect(body.clusters).toHaveLength(2);
    expect(body.clusters.every((c) => c.source === 'user')).toBe(true);
    expect(body.clusters.map((c) => c.clusterId).sort()).toEqual([
      'another',
      'new-cluster',
    ]);
    // old-cluster + new-cluster + another all enqueued for Tier 2 regen.
    const queued = ctx.clusterQueue.listForFolder(folder.id);
    const queuedIds = queued.map((q) => q.clusterId).sort();
    expect(queuedIds).toEqual(['another', 'new-cluster', 'old-cluster']);
  });

  it('PUT with empty clusters array clears all assignments', async () => {
    activatePro(ctx.settings);
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({
      noteId: note.id,
      clusterId: 'will-be-cleared',
      source: 'user',
    });
    const res = await ctx.app.request(`/api/notes/${note.id}/clusters`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clusters: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clusters: unknown[] };
    expect(body.clusters).toEqual([]);
    expect(ctx.clusters.listForNote(note.id)).toEqual([]);
  });
});

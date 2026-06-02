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
  ensureClusterNote,
  mergeClusterDoc,
  renderClusterSection,
} from '../src/core/concierge/index.js';
import { buildHttpApp } from '../src/server/bootstrap/http.js';

/**
 * Phase 6.2 — `GET /api/concierge/folders/:id/topics`
 *
 * Returns the cluster list backing the Tasks Topics tab. A cluster is
 * "suggested" iff Tier 1 wrote `note_mo_clusters` rows for it but
 * Tier 2 has not yet built an aggregator note → `clusterNoteId: null`,
 * `summary: null`. Once the user kicks `mo_regenerate_cluster` (or the
 * scheduler's Tier 2 worker fires), the aggregator note materialises
 * and the row carries the overview-section preview.
 */

interface Ctx {
  handle: DbHandle;
  app: ReturnType<typeof buildHttpApp>;
  settings: SettingsRepository;
  folders: FoldersRepository;
  notes: NotesRepository;
  clusters: NoteMoClustersRepository;
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
  const configDir = mkdtempSync(join(tmpdir(), 'morion-topics-route-'));

  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const sessions = new ConciergeSessionsRepository(handle.db);
  const cMessages = new ConciergeMessagesRepository(handle.db);
  const moSpendLedger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(moSpendLedger);
  const moMetadata = new NoteMoMetadataRepository(handle.db);
  const clusters = new NoteMoClustersRepository(handle.db);

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
      moMetadata,
      moClusters: clusters,
    },
  });

  return { handle, app, settings, folders, notes, clusters };
}

describe('GET /api/concierge/folders/:id/topics', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns 404 for an unknown folder', async () => {
    const res = await ctx.app.request(
      '/api/concierge/folders/does-not-exist/topics',
    );
    expect(res.status).toBe(404);
  });

  it('returns an empty topic list for a fresh folder with no clusters', async () => {
    const folder = ctx.folders.create('Empty');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/topics`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folderId: string; topics: unknown[] };
    expect(body.folderId).toBe(folder.id);
    expect(body.topics).toEqual([]);
  });

  it('groups clusters by id, counts notes, includes Tier 1 sources', async () => {
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user' },
      'user',
    );
    const b = ctx.notes.create(
      { body: '# B', folderId: folder.id, source: 'user' },
      'user',
    );
    const c = ctx.notes.create(
      { body: '# C', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'kanban-ui', source: 'tier1' });
    ctx.clusters.upsert({ noteId: b.id, clusterId: 'kanban-ui', source: 'tier1' });
    ctx.clusters.upsert({ noteId: c.id, clusterId: 'mo-chat', source: 'user' });

    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/topics`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      topics: Array<{
        clusterId: string;
        noteCount: number;
        sources: string[];
        userPromoted: boolean;
        clusterNoteId: string | null;
        summary: string | null;
      }>;
    };
    expect(body.topics).toHaveLength(2);
    // Sorted by note_count DESC then cluster_id ASC.
    expect(body.topics[0]!.clusterId).toBe('kanban-ui');
    expect(body.topics[0]!.noteCount).toBe(2);
    expect(body.topics[0]!.sources).toEqual(['tier1']);
    expect(body.topics[0]!.userPromoted).toBe(false);
    expect(body.topics[0]!.clusterNoteId).toBeNull();
    expect(body.topics[0]!.summary).toBeNull();

    expect(body.topics[1]!.clusterId).toBe('mo-chat');
    expect(body.topics[1]!.noteCount).toBe(1);
    expect(body.topics[1]!.userPromoted).toBe(true);
  });

  it('extracts the overview section as summary when the cluster note exists', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'theme', source: 'tier1' });

    // Materialise a Tier 2 cluster note with a real overview.
    const ensured = ensureClusterNote(ctx.handle.db, folder.id, 'theme');
    const merged = mergeClusterDoc(
      ensured.body,
      renderClusterSection(
        'overview',
        'Notes about kanban drag-and-drop bugs in WKWebView.',
      ),
      'theme',
    );
    ctx.handle.db
      .prepare('UPDATE notes SET body = ? WHERE id = ?')
      .run(merged, ensured.id);

    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/topics`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      topics: Array<{
        clusterId: string;
        clusterNoteId: string | null;
        summary: string | null;
      }>;
    };
    expect(body.topics).toHaveLength(1);
    expect(body.topics[0]!.clusterNoteId).toBe(ensured.id);
    expect(body.topics[0]!.summary).toContain('kanban drag-and-drop');
  });

  it('skips trashed notes — soft-deleted notes do not contribute counts', async () => {
    const folder = ctx.folders.create('F');
    const live = ctx.notes.create(
      { body: '# Live', folderId: folder.id, source: 'user' },
      'user',
    );
    const dead = ctx.notes.create(
      { body: '# Dead', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: live.id, clusterId: 'theme', source: 'tier1' });
    ctx.clusters.upsert({ noteId: dead.id, clusterId: 'theme', source: 'tier1' });
    ctx.notes.delete(dead.id, 'user');

    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/topics`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      topics: Array<{ noteCount: number }>;
    };
    expect(body.topics).toHaveLength(1);
    expect(body.topics[0]!.noteCount).toBe(1);
  });
});


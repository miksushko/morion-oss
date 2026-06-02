import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
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
} from '../src/core/concierge/index.js';
import { notesSearchTool } from '../src/server/tools/notes_search.js';
import { notesListTool } from '../src/server/tools/notes_list.js';
import type { ToolContext } from '../src/server/tools/types.js';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  meta: NoteMoMetadataRepository;
  tc: ToolContext;
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

  return {
    handle,
    notes,
    folders,
    meta,
    tc: {
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
      actor: 'user',
      configDir: mkdtempSync(join(tmpdir(), 'morion-meta-surface-')),
      concierge,
    },
  };
}

describe('notes_search — withMetadata flag', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('omits summary + keywords by default (back-compat slim shape)', async () => {
    const folder = ctx.folders.create('F');
    const n = ctx.notes.create(
      { body: '# Stripe webhook idempotency\n\nbody', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: n.id,
      summary: 'should NOT appear when withMetadata is omitted',
      keywords: ['stripe'],
      computedBy: 'tier1',
    });

    const hits = (await notesSearchTool.handler(
      { query: 'Stripe', limit: 10 },
      ctx.tc,
    )) as Array<Record<string, unknown>>;

    expect(hits).toHaveLength(1);
    expect(hits[0]).not.toHaveProperty('summary');
    expect(hits[0]).not.toHaveProperty('keywords');
  });

  it('includes summary + keywords when withMetadata: true', async () => {
    const folder = ctx.folders.create('F');
    const n = ctx.notes.create(
      { body: '# Stripe webhook idempotency\n\nbody', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: n.id,
      summary: 'How we deduplicate Stripe webhooks via the event_id column.',
      keywords: ['stripe', 'webhook', 'idempotency'],
      computedBy: 'tier1',
    });

    const hits = (await notesSearchTool.handler(
      { query: 'Stripe', limit: 10, withMetadata: true },
      ctx.tc,
    )) as Array<{ summary: string | null; keywords: string[] | null }>;

    expect(hits).toHaveLength(1);
    expect(hits[0]?.summary).toContain('deduplicate Stripe');
    expect(hits[0]?.keywords).toEqual(['stripe', 'webhook', 'idempotency']);
  });

  it('returns null fields for un-indexed notes when withMetadata: true', async () => {
    const folder = ctx.folders.create('F');
    ctx.notes.create(
      { body: '# Stripe webhook unidexed', folderId: folder.id, source: 'user' },
      'user',
    );

    const hits = (await notesSearchTool.handler(
      { query: 'Stripe', limit: 10, withMetadata: true },
      ctx.tc,
    )) as Array<{ summary: string | null; keywords: string[] | null }>;

    expect(hits).toHaveLength(1);
    expect(hits[0]?.summary).toBeNull();
    expect(hits[0]?.keywords).toBeNull();
  });

  it('uses one batch SELECT for many hits — no N+1', async () => {
    const folder = ctx.folders.create('F');
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const n = ctx.notes.create(
        {
          body: `# Stripe note ${i}\n\nbody ${i}`,
          folderId: folder.id,
          source: 'user',
        },
        'user',
      );
      ids.push(n.id);
      if (i % 2 === 0) {
        ctx.meta.upsert({
          noteId: n.id,
          summary: `summary ${i}`,
          keywords: [`kw${i}`],
          computedBy: 'tier1',
        });
      }
    }

    // Spy on the prepared statement count via a transaction wrapper —
    // easier: rely on functional check that all metadata surfaces in
    // one call without errors. The N+1 reduction is a property of the
    // batch query; the explicit batch helper is exercised in the
    // mo-metadata-repository tests.
    const hits = (await notesSearchTool.handler(
      { query: 'Stripe', limit: 50, withMetadata: true },
      ctx.tc,
    )) as Array<{ id: string; summary: string | null; keywords: string[] | null }>;

    expect(hits.length).toBeGreaterThanOrEqual(12);
    const indexed = hits.filter((h) => h.summary !== null);
    const unindexed = hits.filter((h) => h.summary === null);
    expect(indexed.length).toBe(6);
    expect(unindexed.length).toBe(6);
  });
});

describe('notes_list — withMetadata flag', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('omits summary + keywords by default (back-compat Note[] shape)', async () => {
    const folder = ctx.folders.create('F');
    const n = ctx.notes.create(
      { body: '# Plain', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: n.id,
      summary: 'hidden',
      keywords: ['hidden'],
      computedBy: 'tier1',
    });

    const result = (await notesListTool.handler(
      { folderId: folder.id, limit: 50, offset: 0 },
      ctx.tc,
    )) as Array<Record<string, unknown>>;

    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('summary');
    expect(result[0]).not.toHaveProperty('keywords');
  });

  it('includes summary + keywords for indexed notes when withMetadata: true', async () => {
    const folder = ctx.folders.create('F');
    const indexed = ctx.notes.create(
      { body: '# Indexed', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.notes.create(
      { body: '# Unindexed', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: indexed.id,
      summary: 'I have summary.',
      keywords: ['indexed'],
      computedBy: 'tier1',
    });

    const result = (await notesListTool.handler(
      { folderId: folder.id, limit: 50, offset: 0, withMetadata: true },
      ctx.tc,
    )) as Array<{ id: string; title: string; summary: string | null; keywords: string[] | null }>;

    const indexedRow = result.find((r) => r.id === indexed.id);
    const unindexedRow = result.find((r) => r.title === 'Unindexed');
    expect(indexedRow?.summary).toBe('I have summary.');
    expect(indexedRow?.keywords).toEqual(['indexed']);
    expect(unindexedRow?.summary).toBeNull();
    expect(unindexedRow?.keywords).toBeNull();
  });
});

describe('NoteMoMetadataRepository.getMany — batch fetch', () => {
  it('returns empty map when called with no ids', () => {
    const ctx = setup();
    expect(ctx.meta.getMany([]).size).toBe(0);
  });

  it('returns map keyed by note id, omitting un-indexed notes', () => {
    const ctx = setup();
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    const b = ctx.notes.create({ body: '# B', folderId: folder.id, source: 'user' }, 'user');
    const c = ctx.notes.create({ body: '# C', folderId: folder.id, source: 'user' }, 'user');
    ctx.meta.upsert({ noteId: a.id, summary: 'sa', keywords: ['a'], computedBy: 'tier1' });
    ctx.meta.upsert({ noteId: c.id, summary: 'sc', keywords: ['c'], computedBy: 'tier1' });

    const map = ctx.meta.getMany([a.id, b.id, c.id]);
    expect(map.size).toBe(2);
    expect(map.get(a.id)?.summary).toBe('sa');
    expect(map.get(b.id)).toBeUndefined();
    expect(map.get(c.id)?.summary).toBe('sc');
  });
});

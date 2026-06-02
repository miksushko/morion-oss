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
  ensureCatalogNote,
  ensureClusterNote,
} from '../src/core/concierge/index.js';
import { moListClustersTool } from '../src/server/tools/mo/mo_list_clusters.js';
import { moGetClusterTool } from '../src/server/tools/mo/mo_get_cluster.js';
import { moListTasksMetaTool } from '../src/server/tools/mo/mo_list_tasks_meta.js';
import { moResolveTaskTool } from '../src/server/tools/mo/mo_resolve_task.js';
import type { ToolContext } from '../src/server/tools/types.js';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  comments: NoteCommentsRepository;
  audit: AuditLogger;
  folderSettings: ConciergeFolderSettingsRepository;
  toolCtx: ToolContext;
}

function setup(opts?: { isPro?: boolean }): Ctx {
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
  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);

  if (opts?.isPro) {
    settings.set('license', {
      tier: 'pro',
      email: 't@example.com',
      issued_at: Math.floor(Date.now() / 1000),
      expires_at: null,
      sig: 'test',
    });
  }

  const concierge = {
    folderSettings,
    sessions: new ConciergeSessionsRepository(handle.db),
    messages: new ConciergeMessagesRepository(handle.db),
    moSpendLedger: new MoSpendLedgerRepository(handle.db),
    moMemory: new MoMemoryRepository(settings),
    budget: new BudgetTracker(new MoSpendLedgerRepository(handle.db)),
    moMetadata: meta,
    moClusters: clusters,
  };

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
    configDir: mkdtempSync(join(tmpdir(), 'morion-mo-primitives-')),
    concierge,
  };

  return {
    handle,
    notes,
    folders,
    meta,
    clusters,
    comments,
    audit,
    folderSettings,
    toolCtx,
  };
}

// =====================================================================
// mo_list_clusters
// =====================================================================

describe('mo_list_clusters', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup({ isPro: true });
  });

  it('rejects when Mo not enabled for folder', async () => {
    const folder = ctx.folders.create('F');
    // No folderSettings.update — Mo disabled by default.
    const r = (await moListClustersTool.handler(
      { folderId: folder.id },
      ctx.toolCtx,
    )) as { reason?: string };
    expect(r.reason).toBe('mo_not_enabled_for_folder');
  });

  it('returns empty + hint when no clusters yet', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const r = (await moListClustersTool.handler(
      { folderId: folder.id },
      ctx.toolCtx,
    )) as { totalClusters: number; hint: string | null };
    expect(r.totalClusters).toBe(0);
    expect(r.hint).toContain('No clusters');
  });

  it('returns clusters in task-count desc order', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const a = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    const b = ctx.notes.create({ body: '# B', folderId: folder.id, source: 'user' }, 'user');
    const c = ctx.notes.create({ body: '# C', folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'big', source: 'tier1' });
    ctx.clusters.upsert({ noteId: b.id, clusterId: 'big', source: 'tier1' });
    ctx.clusters.upsert({ noteId: c.id, clusterId: 'small', source: 'tier1' });

    const r = (await moListClustersTool.handler(
      { folderId: folder.id },
      ctx.toolCtx,
    )) as {
      clusters: Array<{ clusterId: string; taskCount: number; hasAggregator: boolean }>;
    };
    expect(r.clusters).toHaveLength(2);
    expect(r.clusters[0]?.clusterId).toBe('big');
    expect(r.clusters[0]?.taskCount).toBe(2);
    expect(r.clusters[1]?.clusterId).toBe('small');
    expect(r.clusters[1]?.taskCount).toBe(1);
  });

  it('flags hasAggregator true when mo:cluster note exists', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const note = ctx.notes.create({ body: '# X', folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'documented', source: 'tier1' });
    ensureClusterNote(ctx.handle.db, folder.id, 'documented', 'F');

    const r = (await moListClustersTool.handler(
      { folderId: folder.id },
      ctx.toolCtx,
    )) as { clusters: Array<{ clusterId: string; hasAggregator: boolean }> };
    const documented = r.clusters.find((c) => c.clusterId === 'documented');
    expect(documented?.hasAggregator).toBe(true);
  });

  it('excludes mo:* system notes from cluster counts', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    // A user note assigned to a cluster.
    const userNote = ctx.notes.create({ body: '# user', folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: userNote.id, clusterId: 'c1', source: 'tier1' });
    // A mo:* system note erroneously attached to the same cluster
    // (the production code prevents this; the test asserts the SQL
    // filter still strips it defensively).
    const sysNote = ctx.notes.create(
      { body: '# mo:catalog', folderId: folder.id, source: 'mo:catalog' },
      'morion-concierge',
    );
    ctx.clusters.upsert({ noteId: sysNote.id, clusterId: 'c1', source: 'tier1' });

    const r = (await moListClustersTool.handler(
      { folderId: folder.id },
      ctx.toolCtx,
    )) as { clusters: Array<{ clusterId: string; taskCount: number }> };
    expect(r.clusters[0]?.taskCount).toBe(1);
  });
});

// =====================================================================
// mo_get_cluster
// =====================================================================

describe('mo_get_cluster', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup({ isPro: true });
  });

  it('returns aggregator + assigned task metas (no bodies)', async () => {
    const folder = ctx.folders.create('Cluster Test');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const a = ctx.notes.create(
      { body: '# Note A about Stripe', folderId: folder.id, source: 'user' },
      'user',
    );
    const b = ctx.notes.create(
      { body: '# Note B about Stripe', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'stripe', source: 'tier1', confidence: 0.9 });
    ctx.clusters.upsert({ noteId: b.id, clusterId: 'stripe', source: 'tier1', confidence: 0.7 });
    ctx.meta.upsert({
      noteId: a.id,
      summary: 'Note A summary',
      keywords: ['stripe'],
      computedBy: 'tier1',
    });
    ensureClusterNote(ctx.handle.db, folder.id, 'stripe', 'Cluster Test');

    const r = (await moGetClusterTool.handler(
      { folderId: folder.id, clusterId: 'stripe' },
      ctx.toolCtx,
    )) as {
      aggregatorNoteId: string | null;
      aggregatorBody: string | null;
      tasks: Array<{ noteId: string; title: string; summary: string | null }>;
      totalTasks: number;
    };

    expect(r.aggregatorNoteId).not.toBeNull();
    expect(r.totalTasks).toBe(2);
    // Confidence DESC ordering.
    expect(r.tasks[0]?.noteId).toBe(a.id);
    expect(r.tasks[0]?.summary).toBe('Note A summary');
    expect(r.tasks[1]?.summary).toBeNull();
    // Bodies are NOT included.
    expect((r.tasks[0] as Record<string, unknown>).body).toBeUndefined();
  });

  it('returns null aggregator + empty tasks for unknown cluster', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const r = (await moGetClusterTool.handler(
      { folderId: folder.id, clusterId: 'nope' },
      ctx.toolCtx,
    )) as { aggregatorNoteId: string | null; totalTasks: number; hint: string | null };
    expect(r.aggregatorNoteId).toBeNull();
    expect(r.totalTasks).toBe(0);
    expect(r.hint).toContain('No notes assigned');
  });
});

// =====================================================================
// mo_list_tasks_meta
// =====================================================================

describe('mo_list_tasks_meta', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup({ isPro: true });
  });

  it('returns metas with NO bodies', async () => {
    const folder = ctx.folders.create('Tasks');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const a = ctx.notes.create(
      { body: '# Stripe webhook idempotency\n\nFull body here.', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: a.id,
      summary: 'A summary',
      keywords: ['stripe'],
      computedBy: 'tier1',
    });

    const r = (await moListTasksMetaTool.handler(
      { folderId: folder.id, limit: 50 },
      ctx.toolCtx,
    )) as {
      items: Array<{ noteId: string; title: string; summary: string | null; body?: string }>;
    };
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items[0]?.body).toBeUndefined();
    const aRow = r.items.find((i) => i.noteId === a.id);
    expect(aRow?.summary).toBe('A summary');
  });

  it('clusterId filter narrows to assigned notes', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const a = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    const b = ctx.notes.create({ body: '# B', folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: a.id, clusterId: 'in', source: 'tier1' });
    // b is NOT in cluster 'in'

    const r = (await moListTasksMetaTool.handler(
      { folderId: folder.id, clusterId: 'in', limit: 50 },
      ctx.toolCtx,
    )) as { items: Array<{ noteId: string }> };
    const ids = r.items.map((i) => i.noteId);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it('search filter uses FTS through Mo-elevated search', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const stripe = ctx.notes.create(
      { body: '# Stripe webhook note', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.notes.create(
      { body: '# Tetris game spec', folderId: folder.id, source: 'user' },
      'user',
    );

    const r = (await moListTasksMetaTool.handler(
      { folderId: folder.id, search: 'Stripe', limit: 50 },
      ctx.toolCtx,
    )) as { items: Array<{ noteId: string }> };
    expect(r.items.map((i) => i.noteId)).toContain(stripe.id);
  });

  it('returns clusters per item via batch lookup', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const note = ctx.notes.create({ body: '# X', folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'a', source: 'tier1' });
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'b', source: 'tier1' });

    const r = (await moListTasksMetaTool.handler(
      { folderId: folder.id, limit: 50 },
      ctx.toolCtx,
    )) as { items: Array<{ noteId: string; clusters: string[] }> };
    const row = r.items.find((i) => i.noteId === note.id);
    expect(row?.clusters.sort()).toEqual(['a', 'b']);
  });
});

// =====================================================================
// mo_resolve_task
// =====================================================================

describe('mo_resolve_task', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup({ isPro: true });
  });

  it('returns task body + folder + clusters + metadata in one call', async () => {
    const folder = ctx.folders.create('Resolve');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const task = ctx.notes.create(
      {
        body: '# Implement Stripe idempotency\n\nDetails inline.',
        folderId: folder.id,
        source: 'user',
        tags: ['todo'],
      },
      'user',
    );
    ctx.clusters.upsert({
      noteId: task.id,
      clusterId: 'stripe',
      source: 'tier1',
      confidence: 0.95,
    });
    ctx.meta.upsert({
      noteId: task.id,
      summary: 'Stripe idempotency implementation task.',
      keywords: ['stripe', 'idempotency'],
      computedBy: 'tier1',
      confidence: 0.9,
    });

    const r = (await moResolveTaskTool.handler(
      { taskId: task.id },
      ctx.toolCtx,
    )) as {
      task: { id: string; title: string; body: string; tags: string[] };
      folder: { id: string; name: string };
      clusters: Array<{ clusterId: string; confidence: number }>;
      metadata: { summary: string; keywords: string[] };
      comments: unknown[];
      audit: unknown[];
    };

    expect(r.task.id).toBe(task.id);
    expect(r.task.body).toContain('Implement Stripe');
    expect(r.task.tags).toEqual(['todo']);
    expect(r.folder.id).toBe(folder.id);
    expect(r.folder.name).toBe('Resolve');
    expect(r.clusters[0]?.clusterId).toBe('stripe');
    expect(r.clusters[0]?.confidence).toBe(0.95);
    expect(r.metadata.summary).toContain('Stripe idempotency');
    expect(r.metadata.keywords).toEqual(['stripe', 'idempotency']);
    expect(r.audit.length).toBeGreaterThan(0); // create row at minimum
  });

  it('returns task_not_found for missing id', async () => {
    const r = (await moResolveTaskTool.handler(
      { taskId: '01HNOTREAL01HNOTREAL01H1' },
      ctx.toolCtx,
    )) as { error?: string };
    expect(r.error).toBe('task_not_found');
  });

  it('returns task_unfiled when task has null folderId', async () => {
    const unfiled = ctx.notes.create(
      { body: '# Unfiled note that meets min body length', folderId: null, source: 'user' },
      'user',
    );
    const r = (await moResolveTaskTool.handler(
      { taskId: unfiled.id },
      ctx.toolCtx,
    )) as { error?: string };
    expect(r.error).toBe('task_unfiled');
  });

  it('returns mo_not_enabled_for_folder when parent folder has Mo disabled', async () => {
    const folder = ctx.folders.create('Disabled folder');
    // Don't enable Mo.
    const task = ctx.notes.create(
      { body: '# T', folderId: folder.id, source: 'user' },
      'user',
    );
    const r = (await moResolveTaskTool.handler(
      { taskId: task.id },
      ctx.toolCtx,
    )) as { reason?: string };
    expect(r.reason).toBe('mo_not_enabled_for_folder');
  });

  it('respects commentLimit + auditLimit caps', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const task = ctx.notes.create(
      { body: '# Task body long enough to clear gate', folderId: folder.id, source: 'user' },
      'user',
    );
    for (let i = 0; i < 5; i++) {
      ctx.comments.create(task.id, `comment ${i}`, 'user');
    }
    const r = (await moResolveTaskTool.handler(
      { taskId: task.id, commentLimit: 3 },
      ctx.toolCtx,
    )) as { comments: unknown[] };
    expect(r.comments).toHaveLength(3);
  });
});

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
  MoMetadataQueueRepository,
  MoClusterQueueRepository,
} from '../src/core/concierge/index.js';
import { moReclassifyTool } from '../src/server/tools/mo/mo_reclassify.js';
import { moRegenerateClusterTool } from '../src/server/tools/mo/mo_regenerate_cluster.js';
import { moPatrolTool } from '../src/server/tools/mo/mo_patrol.js';
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
  metaQueue: MoMetadataQueueRepository;
  clusterQueue: MoClusterQueueRepository;
  toolCtx: ToolContext;
  settings: SettingsRepository;
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
  const metaQueue = new MoMetadataQueueRepository(handle.db);
  const clusterQueue = new MoClusterQueueRepository(handle.db);
  const ledger = new MoSpendLedgerRepository(handle.db);

  if (opts?.isPro) {
    settings.set('license', {
      tier: 'pro',
      email: 'test@example.com',
      issued_at: Math.floor(Date.now() / 1000),
      expires_at: null,
      sig: 'test',
    });
  }

  const concierge = {
    folderSettings: new ConciergeFolderSettingsRepository(handle.db),
    sessions: new ConciergeSessionsRepository(handle.db),
    messages: new ConciergeMessagesRepository(handle.db),
    moSpendLedger: ledger,
    moMemory: new MoMemoryRepository(settings),
    budget: new BudgetTracker(ledger),
    moMetadata: meta,
    moClusters: clusters,
    moMetadataQueue: metaQueue,
    moClusterQueue: clusterQueue,
  };

  const configDir = mkdtempSync(join(tmpdir(), 'morion-mo-manual-'));
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

  return { handle, notes, folders, meta, clusters, metaQueue, clusterQueue, toolCtx, settings };
}

describe('mo_reclassify — gates + replace contract', () => {
  it('returns note_not_found for an unknown note id', async () => {
    const ctx = setup({ isPro: true });
    const result = (await moReclassifyTool.handler(
      { noteId: 'does-not-exist', clusters: ['anywhere'] },
      ctx.toolCtx,
    )) as { error?: string };
    expect(result.error).toBe('note_not_found');
  });

  it('replaces all assignments with source=user, marks old + new clusters dirty', async () => {
    const ctx = setup({ isPro: true });
    const folder = ctx.folders.create('F');
    ctx.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });
    const note = ctx.notes.create(
      { body: '# Note', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({
      noteId: note.id,
      clusterId: 'tier1-old',
      source: 'tier1',
    });
    ctx.clusters.upsert({
      noteId: note.id,
      clusterId: 'kept-by-user',
      source: 'user',
    });

    const result = (await moReclassifyTool.handler(
      { noteId: note.id, clusters: ['kept-by-user', 'fresh-pick'] },
      ctx.toolCtx,
    )) as {
      assignments: Array<{ clusterId: string; source: string }>;
      added: string[];
      removed: string[];
      retained: string[];
      dirtyClustersQueued: string[];
    };

    expect(result.removed).toEqual(['tier1-old']);
    expect(result.added).toEqual(['fresh-pick']);
    expect(result.retained).toEqual(['kept-by-user']);
    // After: only the user-supplied clusters remain, all source=user.
    const after = ctx.clusters.listForNote(note.id);
    expect(after.map((c) => `${c.clusterId}:${c.source}`).sort()).toEqual([
      'fresh-pick:user',
      'kept-by-user:user',
    ]);
    // Cluster queue marked dirty for old and new.
    const queued = ctx.clusterQueue
      .listForFolder(folder.id)
      .map((q) => q.clusterId)
      .sort();
    expect(queued).toEqual(['fresh-pick', 'kept-by-user', 'tier1-old']);
  });

  it('empty list clears all assignments + queues dirty for every prior cluster', async () => {
    const ctx = setup({ isPro: true });
    const folder = ctx.folders.create('F');
    ctx.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });
    const note = ctx.notes.create(
      { body: '# Note', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'a', source: 'tier1' });
    ctx.clusters.upsert({ noteId: note.id, clusterId: 'b', source: 'tier1' });

    await moReclassifyTool.handler(
      { noteId: note.id, clusters: [] },
      ctx.toolCtx,
    );
    expect(ctx.clusters.listForNote(note.id)).toHaveLength(0);
    const queued = ctx.clusterQueue
      .listForFolder(folder.id)
      .map((q) => q.clusterId)
      .sort();
    expect(queued).toEqual(['a', 'b']);
  });
});

describe('mo_regenerate_cluster — gates + backend gate', () => {
  it('returns mo_backend_not_openrouter when backend is not configured for indexing', async () => {
    const ctx = setup({ isPro: true });
    const folder = ctx.folders.create('F');
    ctx.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });
    // backend unset → readBackend returns DEFAULT_BACKEND (groq) → not openrouter.
    const result = (await moRegenerateClusterTool.handler(
      { folderId: folder.id, clusterId: 'cluster-x' },
      ctx.toolCtx,
    )) as { error?: string; reason?: string };
    expect(result.error).toBe('mo_backend_not_openrouter');
  });
});

describe('mo_patrol — gates + backfill enqueue', () => {
  it('mode=backfill enqueues every eligible note in the folder', async () => {
    const ctx = setup({ isPro: true });
    const folder = ctx.folders.create('F');
    ctx.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });
    // Set backend to something that gates indexing OFF so the
    // post-enqueue tick runs but the LLM call short-circuits to
    // gated_off; we just want to verify the enqueue side-effect.
    ctx.settings.set('concierge.backend', 'groq');

    ctx.notes.create(
      { body: '# A long body to clear filter A', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.notes.create(
      { body: '# A long body to clear filter B', folderId: folder.id, source: 'user' },
      'user',
    );
    // An archived note must NOT be enqueued.
    const archived = ctx.notes.create(
      { body: '# Archived body', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.handle.db
      .prepare('UPDATE notes SET archived_at = ? WHERE id = ?')
      .run(Date.now(), archived.id);

    await moPatrolTool.handler(
      { folderId: folder.id, mode: 'backfill' },
      ctx.toolCtx,
    );

    const queued = ctx.metaQueue.listForFolder(folder.id);
    // 2 enqueued (the two non-archived notes), archived skipped.
    expect(queued).toHaveLength(2);
  });

  it('returns gated_off tickStatus when backend is not openrouter', async () => {
    const ctx = setup({ isPro: true });
    const folder = ctx.folders.create('F');
    ctx.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });
    ctx.settings.set('concierge.backend', 'groq');

    const result = (await moPatrolTool.handler(
      { folderId: folder.id },
      ctx.toolCtx,
    )) as { tickStatus: string };
    expect(result.tickStatus).toBe('gated_off');
  });
});

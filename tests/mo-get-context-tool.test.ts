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
  MoMetadataVecRepository,
  MoContextCacheRepository,
} from '../src/core/concierge/index.js';
import { moGetContextTool } from '../src/server/tools/mo/mo_get_context.js';
import type { ToolContext } from '../src/server/tools/types.js';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  folderSettings: ConciergeFolderSettingsRepository;
  toolCtx: ToolContext;
}

function setup(opts?: { isPro?: boolean; openrouterKey?: string }): Ctx {
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
  const moMetadataVec = new MoMetadataVecRepository(handle.db, handle.hasVec);
  const cache = new MoContextCacheRepository(handle.db);
  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const ledger = new MoSpendLedgerRepository(handle.db);
  const budget = new BudgetTracker(ledger);

  if (opts?.isPro) {
    settings.set('license', {
      tier: 'pro',
      email: 't@example.com',
      issued_at: Math.floor(Date.now() / 1000),
      expires_at: null,
      sig: 'test',
    });
  }

  if (opts?.openrouterKey) {
    settings.set('concierge.backend', 'openrouter');
    settings.set('concierge.openrouter_api_key', opts.openrouterKey);
  }

  const concierge = {
    folderSettings,
    sessions: new ConciergeSessionsRepository(handle.db),
    messages: new ConciergeMessagesRepository(handle.db),
    moSpendLedger: ledger,
    moMemory: new MoMemoryRepository(settings),
    budget,
    moMetadata: meta,
    moClusters: clusters,
    moMetadataVec,
    moContextCache: cache,
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
    embeddings,
    audit,
    settings,
    actor: 'mcp:test',
    configDir: mkdtempSync(join(tmpdir(), 'morion-mo-get-context-')),
    concierge,
  };

  return { handle, notes, folders, folderSettings, toolCtx };
}

describe('mo_get_context — input validation', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup({ isPro: true, openrouterKey: 'or-test-key' });
  });

  it('rejects when neither taskId nor question is supplied', async () => {
    const r = (await moGetContextTool.handler({}, ctx.toolCtx)) as {
      error?: string;
    };
    expect(r.error).toBe('invalid_input');
  });

  it('rejects when both taskId and question are supplied', async () => {
    const r = (await moGetContextTool.handler(
      { taskId: '01H', question: 'x' },
      ctx.toolCtx,
    )) as { error?: string };
    expect(r.error).toBe('invalid_input');
  });
});

describe('mo_get_context — Pro / Mo gates', () => {
  it('rejects when folderId targets a folder without Mo enabled', async () => {
    const ctx = setup({ isPro: true, openrouterKey: 'or-test-key' });
    const folder = ctx.folders.create('Disabled');
    // No folderSettings.update — Mo disabled by default.
    const r = (await moGetContextTool.handler(
      { question: 'x', folderId: folder.id },
      ctx.toolCtx,
    )) as { reason?: string };
    expect(r.reason).toBe('mo_not_enabled_for_folder');
  });
});

describe('mo_get_context — task resolution', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup({ isPro: true, openrouterKey: 'or-test-key' });
  });

  it('returns task_not_found for unknown taskId', async () => {
    const r = (await moGetContextTool.handler(
      { taskId: '01HNOTREAL01HNOTREAL01H1' },
      ctx.toolCtx,
    )) as { error?: string };
    expect(r.error).toBe('task_not_found');
  });

  it('returns task_deleted for soft-deleted task', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const task = ctx.notes.create(
      { body: '# T body long enough for gates', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.notes.delete(task.id, 'user');
    const r = (await moGetContextTool.handler(
      { taskId: task.id },
      ctx.toolCtx,
    )) as { error?: string };
    expect(r.error).toBe('task_deleted');
  });

  it('returns task_unfiled for unfiled task', async () => {
    const task = ctx.notes.create(
      { body: '# unfiled body long enough', folderId: null, source: 'user' },
      'user',
    );
    const r = (await moGetContextTool.handler(
      { taskId: task.id },
      ctx.toolCtx,
    )) as { error?: string };
    expect(r.error).toBe('task_unfiled');
  });

  it('flows through to provider gate when task + Mo enabled OK', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const task = ctx.notes.create(
      { body: '# Task body long enough for gates', folderId: folder.id, source: 'user' },
      'user',
    );
    // Provider key was set but the OpenRouter constructor doesn't
    // throw on construct (lazy auth), so we get past the provider
    // gate and into the engine. The engine in turn would dispatch a
    // real network call; we just need to assert we reached the
    // budget pre-flight (no LLM call for empty budget).
    const r = (await moGetContextTool.handler(
      { taskId: task.id },
      ctx.toolCtx,
    )) as { error?: string; capped?: string; spentUsd?: number };
    // We should NOT get a gate-rejection envelope; we should get either
    // a gather packet shape (with capped or spentUsd) OR a provider
    // network failure surfaced through the engine. Either way, NOT
    // task_not_found / mo_pro_required / etc.
    expect(r.error).not.toBe('task_not_found');
    expect(r.error).not.toBe('task_unfiled');
    expect(r.error).not.toBe('invalid_input');
  });
});

describe('mo_get_context — provider gate', () => {
  it('returns mo_provider_unconfigured when no OpenRouter key set', async () => {
    const ctx = setup({ isPro: true });
    // No openrouterKey passed → backend setting absent → resolveMoIndexingProvider returns null.
    const r = (await moGetContextTool.handler(
      { question: 'x' },
      ctx.toolCtx,
    )) as { error?: string };
    expect(r.error).toBe('mo_provider_unconfigured');
  });
});

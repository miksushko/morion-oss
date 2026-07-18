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
  toMoInternalCtx,
  MO_ACTOR,
} from '../src/core/concierge/index.js';
import { canPerform } from '../src/core/permissions/check.js';
import { isNoteMcpHidden } from '../src/core/archive/check.js';
import { moSearchTool } from '../src/server/tools/mo/mo_search.js';
import { notesSearchTool } from '../src/server/tools/notes_search.js';
import type { ToolContext } from '../src/server/tools/types.js';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  toolCtx: ToolContext;
}

function setup(opts: { actor: string; moEnabledFolderId?: string }): Ctx {
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


  const concierge = {
    folderSettings: new ConciergeFolderSettingsRepository(handle.db),
    sessions: new ConciergeSessionsRepository(handle.db),
    messages: new ConciergeMessagesRepository(handle.db),
    moSpendLedger: new MoSpendLedgerRepository(handle.db),
    moMemory: new MoMemoryRepository(settings),
    budget: new BudgetTracker(new MoSpendLedgerRepository(handle.db)),
    moMetadata: meta,
    moClusters: clusters,
    moMetadataVec,
  };

  if (opts.moEnabledFolderId) {
    concierge.folderSettings.update(opts.moEnabledFolderId, { enabled: true });
  }

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
    actor: opts.actor,
    configDir: mkdtempSync(join(tmpdir(), 'morion-mo-elevate-')),
    concierge,
  };

  return { handle, notes, folders, meta, clusters, toolCtx };
}

describe('toMoInternalCtx — owner-level elevation contract', () => {
  it('flips actor to MO_ACTOR while preserving every other field', () => {
    const { toolCtx } = setup({ actor: 'mcp:claude-code' });
    const elevated = toMoInternalCtx(toolCtx);
    expect(elevated.actor).toBe(MO_ACTOR);
    expect(elevated.actor).toBe('morion-concierge');
    expect(elevated.db).toBe(toolCtx.db);
    expect(elevated.notes).toBe(toolCtx.notes);
    expect(elevated.folders).toBe(toolCtx.folders);
    expect(elevated.search).toBe(toolCtx.search);
    expect(elevated.concierge).toBe(toolCtx.concierge);
  });

  it('elevated context bypasses the MCP archive gate at the canPerform level', () => {
    const ctx = setup({ actor: 'mcp:claude-code' });
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# Archived note', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.notes.archive(note.id, 'user');

    // Original mcp actor → archive gate fires → denied.
    expect(
      canPerform('read', ctx.toolCtx, { kind: 'note', noteId: note.id }),
    ).toBe(false);

    // Elevated to morion-concierge → archive gate skipped → allowed.
    const moCtx = toMoInternalCtx(ctx.toolCtx);
    expect(canPerform('read', moCtx, { kind: 'note', noteId: note.id })).toBe(
      true,
    );
  });

  it('isNoteMcpHidden still returns true for archived notes (gate primitive unchanged)', () => {
    const ctx = setup({ actor: 'mcp:claude-code' });
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# X', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.notes.archive(note.id, 'user');
    const fetched = ctx.notes.getById(note.id, { includeTrashed: true });
    expect(fetched).not.toBeNull();
    expect(isNoteMcpHidden(fetched!, ctx.toolCtx)).toBe(true);
  });
});

describe('mo_search — surfaces archived notes for any MCP caller (Mo elevates internally)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup({ actor: 'mcp:claude-code' });
  });

  it('returns archived note via mo_search even when caller is mcp:claude-code', async () => {
    const folder = ctx.folders.create('Archive Test');
    ctx.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });

    const live = ctx.notes.create(
      { body: '# Live note about WKWebView dragstart', folderId: folder.id, source: 'user' },
      'user',
    );
    const archived = ctx.notes.create(
      { body: '# Archived WKWebView ticket from last quarter', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.notes.archive(archived.id, 'user');

    const result = (await moSearchTool.handler(
      { query: 'WKWebView', folderId: folder.id, limit: 50 },
      ctx.toolCtx,
    )) as { hits: Array<{ noteId: string }> };

    const ids = result.hits.map((h) => h.noteId);
    expect(ids).toContain(live.id);
    expect(ids).toContain(archived.id);
  });

  it('explicit folderId on an archived folder returns ACCESS_DENIED (outer gate fires before elevation)', async () => {
    // The OUTER `canPerform('read', folder)` runs against the calling
    // MCP actor BEFORE Mo gets a chance to elevate. That's intentional:
    // a caller targeting a specific archived folder is asking about
    // a resource the user has explicitly hidden from MCP. Mo's
    // elevation only relaxes the per-note archive gate AFTER outer
    // gates pass — it doesn't override the folder-level access decision.
    const folder = ctx.folders.create('To Be Archived');
    ctx.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });
    ctx.notes.create(
      { body: '# A note in a folder about WKWebView drama', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.folders.setArchived(folder.id, true);

    const result = (await moSearchTool.handler(
      { query: 'WKWebView', folderId: folder.id, limit: 50 },
      ctx.toolCtx,
    )) as { hits?: unknown; error?: string };

    expect(result.error).toBe('mcp_access_denied');
  });

  it('UNSCOPED mo_search surfaces notes from archived folders (no outer folder gate fires)', async () => {
    // Without `folderId`, the outer per-folder canPerform doesn't run,
    // so Mo's per-note elevation is the operative gate. Archived
    // folder's notes surface in Mo's hits. Pro+enabled-folder gates
    // still pass at the workspace level (they only require the bag
    // exists, no folder-id needed).
    const folder = ctx.folders.create('Old folder');
    ctx.toolCtx.concierge!.folderSettings.update(folder.id, { enabled: true });
    const note = ctx.notes.create(
      { body: '# Long-lived WKWebView note from old archived folder', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.folders.setArchived(folder.id, true);

    const result = (await moSearchTool.handler(
      { query: 'WKWebView', limit: 50 },
      ctx.toolCtx,
    )) as { hits: Array<{ noteId: string }> };

    expect(result.hits.map((h) => h.noteId)).toContain(note.id);
  });
});

describe('notes_search — non-Mo MCP path remains archive-gated (regression guard)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup({ actor: 'mcp:claude-code' });
  });

  it('hides archived notes from notes_search even when caller is the same MCP agent', async () => {
    const folder = ctx.folders.create('F');
    const live = ctx.notes.create(
      { body: '# Live ticket about Stripe webhook', folderId: folder.id, source: 'user' },
      'user',
    );
    const archived = ctx.notes.create(
      { body: '# Old archived Stripe ticket', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.notes.archive(archived.id, 'user');

    const hits = (await notesSearchTool.handler(
      { query: 'Stripe', limit: 50 },
      ctx.toolCtx,
    )) as Array<{ id: string }>;

    const ids = hits.map((h) => h.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(archived.id);
  });
});

describe('audit log records the actor truthfully (elevation does NOT mask)', () => {
  it('a write performed by an elevated context records morion-concierge in audit_log', () => {
    const ctx = setup({ actor: 'mcp:claude-code' });
    const folder = ctx.folders.create('F');
    const moCtx = toMoInternalCtx(ctx.toolCtx);
    // Use elevated actor for a write (mirrors how mo_record / sub-Mo
    // writers would do it).
    ctx.notes.create(
      { body: '# Mo wrote this', folderId: folder.id, source: 'user' },
      moCtx.actor,
    );
    const auditRows = ctx.handle.db
      .prepare('SELECT actor, action FROM audit_log ORDER BY id')
      .all() as { actor: string; action: string }[];
    const created = auditRows.find((r) => r.action === 'create');
    expect(created?.actor).toBe('morion-concierge');
  });
});

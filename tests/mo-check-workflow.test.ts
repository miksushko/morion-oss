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
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  BudgetTracker,
  MoSpendLedgerRepository,
  MoMemoryRepository,
} from '../src/core/concierge/index.js';
import type { ToolContext } from '../src/server/tools/types.js';
import type { Folder } from '../src/core/notes/types.js';
import { moCheckWorkflowTool } from '../src/server/tools/plugins/auto-code.js';

function activatePro(_tc: ToolContext): void {
  // no-op: open-source build has no license tier (kept for call-site compatibility)
}

interface Ctx {
  handle: DbHandle;
  tc: ToolContext;
  folderSettings: ConciergeFolderSettingsRepository;
}

function setup(actor = 'mcp:test-client'): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const settings = new SettingsRepository(handle.db);
  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const messages = new ConciergeMessagesRepository(handle.db);
  const tc: ToolContext = {
    db: handle.db,
    notes,
    folders,
    tags,
    revisions: new RevisionsRepository(handle.db),
    attachments: new AttachmentsRepository(handle.db),
    comments: new NoteCommentsRepository(handle.db),
    search: new HybridSearch(handle.db, fts, vec, embeddings),
    indexer: new Indexer(vec, embeddings),
    audit,
    settings,
    actor,
    configDir: mkdtempSync(join(tmpdir(), 'morion-mo-check-workflow-')),
    concierge: {
      folderSettings,
      sessions: new ConciergeSessionsRepository(handle.db),
      messages,
      moSpendLedger: new MoSpendLedgerRepository(handle.db),
      moMemory: new MoMemoryRepository(settings),
      budget: new BudgetTracker(new MoSpendLedgerRepository(handle.db)),
    },
  };
  return { handle, tc, folderSettings };
}
function setupProMo(workflow = ''): { ctx: Ctx; folder: Folder } {
  const ctx = setup();
  activatePro(ctx.tc);
  const folder = ctx.tc.folders.create('Project A');
  ctx.folderSettings.update(folder.id, { enabled: true, workflow });
  return { ctx, folder };
}

describe('mo_check_workflow — gates', () => {
  it('Pro + Mo disabled denied with mo_not_enabled_for_folder', async () => {
    const ctx = setup();
    activatePro(ctx.tc);
    const folder = ctx.tc.folders.create('F');
    const r = (await moCheckWorkflowTool.handler(
      { folderId: folder.id, intendedAction: 'create', summary: 'x' },
      ctx.tc,
    )) as any;
    expect(r).toMatchObject({
      error: 'mcp_access_denied',
      reason: 'mo_not_enabled_for_folder',
    });
  });

  // Note: `folder_not_found` is reachable only via a future schema
  // change — today CASCADE on `folders` drops `concierge_folder_settings`
  // too, so a deleted folder fails the Mo-enabled gate first. The
  // defensive check stays in the tool; we don't pin an unreachable path
  // with a test that has to fight FK constraints to construct.
});

describe('mo_check_workflow — decisions', () => {
  it('create allowed when folder MCP perms allow', async () => {
    const { ctx, folder } = setupProMo();
    const r = (await moCheckWorkflowTool.handler(
      { folderId: folder.id, intendedAction: 'create', summary: 'add a note' },
      ctx.tc,
    )) as any;
    expect(r.decision).toBe('allow');
    expect(r.permissions.create).toBe(true);
  });

  it('create denied when folder MCP create=false', async () => {
    const { ctx, folder } = setupProMo();
    ctx.handle.db
      .prepare('UPDATE folders SET mcp_create = 0 WHERE id = ?')
      .run(folder.id);
    const r = (await moCheckWorkflowTool.handler(
      { folderId: folder.id, intendedAction: 'create', summary: 'add a note' },
      ctx.tc,
    )) as any;
    expect(r.decision).toBe('deny');
    expect(r.permissions.create).toBe(false);
  });

  it('delete escalates to ask_user with destructive_action', async () => {
    const { ctx, folder } = setupProMo();
    const r = (await moCheckWorkflowTool.handler(
      { folderId: folder.id, intendedAction: 'delete', summary: 'delete one note' },
      ctx.tc,
    )) as any;
    expect(r.decision).toBe('ask_user');
    expect(r.escalation).toBe('destructive_action');
  });

  it('mass operation (>5 ids) escalates regardless of action', async () => {
    const { ctx, folder } = setupProMo();
    const r = (await moCheckWorkflowTool.handler(
      {
        folderId: folder.id,
        intendedAction: 'update',
        summary: 'tag-rename across notes',
        targetIds: ['1', '2', '3', '4', '5', '6'],
      },
      ctx.tc,
    )) as any;
    expect(r.decision).toBe('ask_user');
    expect(r.escalation).toBe('mass_operation');
  });

  it('exactly 5 ids stays under threshold (allow)', async () => {
    const { ctx, folder } = setupProMo();
    const r = (await moCheckWorkflowTool.handler(
      {
        folderId: folder.id,
        intendedAction: 'update',
        summary: '5-item update',
        targetIds: ['1', '2', '3', '4', '5'],
      },
      ctx.tc,
    )) as any;
    expect(r.decision).toBe('allow');
  });

  it('archive single allowed (reversible metadata)', async () => {
    const { ctx, folder } = setupProMo();
    const r = (await moCheckWorkflowTool.handler(
      { folderId: folder.id, intendedAction: 'archive', summary: 'archive 1 note' },
      ctx.tc,
    )) as any;
    expect(r.decision).toBe('allow');
  });

  it('move single allowed (metadata only)', async () => {
    const { ctx, folder } = setupProMo();
    const r = (await moCheckWorkflowTool.handler(
      { folderId: folder.id, intendedAction: 'move', summary: 'move card' },
      ctx.tc,
    )) as any;
    expect(r.decision).toBe('allow');
  });

  it('mass delete escalates AND is destructive — escalation wins as mass_operation when > threshold', async () => {
    const { ctx, folder } = setupProMo();
    const r = (await moCheckWorkflowTool.handler(
      {
        folderId: folder.id,
        intendedAction: 'delete',
        summary: 'mass delete',
        targetIds: ['1', '2', '3', '4', '5', '6', '7'],
      },
      ctx.tc,
    )) as any;
    expect(r.decision).toBe('ask_user');
    // mass_operation check fires before destructive_action — agent
    // sees the bigger blast-radius reason first.
    expect(r.escalation).toBe('mass_operation');
  });

  // Phase 6.7 v2 follow-up (2026-04-28): the per-folder workflow
  // text surface was retired — Mo no longer reads `workflow` from
  // folder settings on smart-tool calls. The field stays in the
  // response shape (always null) so existing agents that branch
  // on it keep working; the gate now relies purely on perms +
  // blast-radius. House-style guidance lives in catalog overview
  // / per-topic doc bodies instead.
  it('always returns workflow=null (workflow text surface retired)', async () => {
    const policy = 'Never delete kanban cards without explicit user confirmation.';
    const { ctx, folder } = setupProMo(policy);
    const r = (await moCheckWorkflowTool.handler(
      { folderId: folder.id, intendedAction: 'create', summary: 'x' },
      ctx.tc,
    )) as any;
    expect(r.workflow).toBeNull();
  });

  it('reason text includes the agent-supplied summary', async () => {
    const { ctx, folder } = setupProMo();
    const r = (await moCheckWorkflowTool.handler(
      { folderId: folder.id, intendedAction: 'create', summary: 'add a fresh note about Stripe' },
      ctx.tc,
    )) as any;
    expect(r.reason).toContain('add a fresh note about Stripe');
  });

  it('permissions object reflects current folder MCP flags', async () => {
    const { ctx, folder } = setupProMo();
    ctx.handle.db
      .prepare('UPDATE folders SET mcp_delete = 0 WHERE id = ?')
      .run(folder.id);
    const r = (await moCheckWorkflowTool.handler(
      { folderId: folder.id, intendedAction: 'create', summary: 'x' },
      ctx.tc,
    )) as any;
    expect(r.permissions.create).toBe(true);
    expect(r.permissions.delete).toBe(false);
  });
});

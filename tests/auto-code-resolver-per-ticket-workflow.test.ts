import { describe, it, expect, beforeEach } from 'vitest';
import { ulid } from 'ulid';

import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { RevisionsRepository } from '../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import { NoteCommentsRepository } from '../src/core/notes/comments-repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import { resolveFolderWorkflow } from '../src/server/features/auto-code-factory/folder-workflow-resolver.js';
import { WorkflowsRepository } from '../src/core/auto-code/workflows/workflows-repository.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../src/core/auto-code/workflows/default-autocode.js';
import { writeFolderWorkflowTemplate } from '../src/server/features/auto-code-template-settings.js';
import type { ToolContext } from '../src/server/tools/types.js';

/**
 * Per-ticket Auto-code workflow override resolution — ticket
 * 01KRWQPDKQ2RZMDBJZ5KN0B7YE.
 *
 * Pins the precedence chain consumed by the orchestrator's admission
 * gate at `enqueueTicket`-time:
 *
 *   1. `notes.workflow_id` (when set + resolves cleanly) wins.
 *   2. Stale per-ticket id (deleted workflow row, retired template)
 *      falls through to the folder-level pinned setting.
 *   3. Folder-level pinned setting wins (existing behaviour).
 *
 * Cross-folder workflow rows are rejected at both levels — a folder
 * can never run a workflow row owned by another folder.
 *
 * Note on test fixtures: every assertion uses CUSTOM workflow rows
 * built from `LEGACY_LINEAR_AUTOCODE_DEFINITION`. Folder-only
 * resolution through built-in v2 templates triggers the v2→legacy
 * provider-readiness gate in production (a separate, already-
 * pinned codepath); using legacy custom rows keeps these tests
 * focused on precedence semantics rather than the v2 gate.
 */

interface Setup {
  handle: DbHandle;
  ctx: ToolContext;
}

function makeCtx(): Setup {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const ctx: ToolContext = {
    db: handle.db,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
    tags: new TagsRepository(handle.db),
    revisions: new RevisionsRepository(handle.db),
    attachments: new AttachmentsRepository(handle.db),
    comments: new NoteCommentsRepository(handle.db),
    search: new HybridSearch(handle.db, fts, vec, embeddings),
    indexer: new Indexer(vec, embeddings),
    audit,
    settings: new SettingsRepository(handle.db),
    actor: 'user',
    configDir: '/tmp/morion-test-per-ticket-workflow',
  };
  return { handle, ctx };
}

describe('resolveFolderWorkflow(taskId) — per-ticket precedence', () => {
  let s: Setup;
  beforeEach(() => {
    s = makeCtx();
  });

  it('per-ticket workflow row id wins over folder-pinned row', () => {
    const folder = s.ctx.folders.create('F');
    const wfRepo = new WorkflowsRepository(s.handle.db);
    const folderDefault = wfRepo.create({
      folderId: folder.id,
      name: 'Folder-pinned',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });
    const perTicket = wfRepo.create({
      folderId: folder.id,
      name: 'Per-ticket',
      definition: { ...LEGACY_LINEAR_AUTOCODE_DEFINITION, name: 'Per-ticket' },
    });
    writeFolderWorkflowTemplate(
      s.ctx.settings,
      s.handle.db,
      folder.id,
      folderDefault.id,
    );

    const task = s.ctx.notes.create(
      { body: 'do thing', folderId: folder.id, source: 'user' },
      'user',
    );
    s.ctx.notes.update(task.id, { workflowId: perTicket.id }, 'user');

    const resolved = resolveFolderWorkflow(s.ctx, folder.id, task.id);
    expect(resolved.workflowId).toBe(perTicket.id);
    expect(resolved.definition.name).toBe('Per-ticket');
  });

  it('null per-ticket workflowId uses folder-pinned row', () => {
    const folder = s.ctx.folders.create('F');
    const wfRepo = new WorkflowsRepository(s.handle.db);
    const folderDefault = wfRepo.create({
      folderId: folder.id,
      name: 'Folder-pinned',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });
    writeFolderWorkflowTemplate(
      s.ctx.settings,
      s.handle.db,
      folder.id,
      folderDefault.id,
    );
    const task = s.ctx.notes.create(
      { body: 'task', folderId: folder.id, source: 'user' },
      'user',
    );
    // workflowId left at null

    const resolved = resolveFolderWorkflow(s.ctx, folder.id, task.id);
    expect(resolved.workflowId).toBe(folderDefault.id);
  });

  it('stale per-ticket id (workflow deleted) falls through to folder default', () => {
    const folder = s.ctx.folders.create('F');
    const wfRepo = new WorkflowsRepository(s.handle.db);
    const folderDefault = wfRepo.create({
      folderId: folder.id,
      name: 'Folder-pinned',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });
    writeFolderWorkflowTemplate(
      s.ctx.settings,
      s.handle.db,
      folder.id,
      folderDefault.id,
    );
    const task = s.ctx.notes.create(
      { body: 'task', folderId: folder.id, source: 'user' },
      'user',
    );
    // Stale ULID — workflow row doesn't exist
    s.ctx.notes.update(task.id, { workflowId: ulid() }, 'user');

    const resolved = resolveFolderWorkflow(s.ctx, folder.id, task.id);
    expect(resolved.workflowId).toBe(folderDefault.id);
  });

  it('per-ticket id pointing at OTHER folder workflow falls through to folder default', () => {
    const fA = s.ctx.folders.create('A');
    const fB = s.ctx.folders.create('B');
    const wfRepo = new WorkflowsRepository(s.handle.db);
    const aDefault = wfRepo.create({
      folderId: fA.id,
      name: 'A-default',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });
    const bOnly = wfRepo.create({
      folderId: fB.id,
      name: 'B-only',
      definition: { ...LEGACY_LINEAR_AUTOCODE_DEFINITION, name: 'B-only' },
    });
    writeFolderWorkflowTemplate(s.ctx.settings, s.handle.db, fA.id, aDefault.id);

    const task = s.ctx.notes.create(
      { body: 'task', folderId: fA.id, source: 'user' },
      'user',
    );
    // Folder A ticket trying to point at folder B's workflow
    s.ctx.notes.update(task.id, { workflowId: bOnly.id }, 'user');

    const resolved = resolveFolderWorkflow(s.ctx, fA.id, task.id);
    expect(resolved.workflowId).toBe(aDefault.id);
  });

  it('omitted taskId arg uses folder-only resolution (back-compat)', () => {
    const folder = s.ctx.folders.create('F');
    const wfRepo = new WorkflowsRepository(s.handle.db);
    const folderDefault = wfRepo.create({
      folderId: folder.id,
      name: 'Folder-pinned',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });
    writeFolderWorkflowTemplate(
      s.ctx.settings,
      s.handle.db,
      folder.id,
      folderDefault.id,
    );

    const resolved = resolveFolderWorkflow(s.ctx, folder.id);
    expect(resolved.workflowId).toBe(folderDefault.id);
  });
});

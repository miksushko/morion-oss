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
import { inspectFolderWorkflowResolution } from '../src/server/features/auto-code-factory/folder-workflow-resolver.js';
import { writeFolderWorkflowTemplate } from '../src/server/features/auto-code-template-settings.js';
import type { ToolContext } from '../src/server/tools/types.js';

/**
 * Workflow-resolution diagnostic — Morion ticket
 * 01KRRXB2K744SKJGAZHW6KET93. The UI calls this to detect when the
 * stored selection can't be resolved by the runner. Pin the four
 * resolution branches (template hit / row hit / row missing / row
 * cross-folder).
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
    configDir: '/tmp/morion-test-workflow-resolution',
  };
  return { handle, ctx };
}

describe('inspectFolderWorkflowResolution', () => {
  let s: Setup;
  beforeEach(() => {
    s = makeCtx();
  });

  it('returns kind=template when stored value is a known template id', () => {
    const folder = s.ctx.folders.create('F');
    writeFolderWorkflowTemplate(s.ctx.settings, s.handle.db, folder.id, 'code-only-v2');

    const diag = inspectFolderWorkflowResolution(s.ctx, folder.id);
    expect(diag.storedId).toBe('code-only-v2');
    expect(diag.resolved.kind).toBe('template');
    if (diag.resolved.kind === 'template') {
      expect(diag.resolved.templateId).toBe('code-only-v2');
      expect(diag.resolved.displayName.toLowerCase()).toContain('code only');
    }
    expect(diag.fellBackBecause).toBeNull();
  });

  it('returns kind=fallback_to_default with unknown_template_id when stored value is gibberish', () => {
    const folder = s.ctx.folders.create('F');
    // Bypass validation — simulate a setting written by a future
    // sidecar / by direct SQL: a non-ULID, non-template id.
    s.ctx.settings.set(
      `auto_code.workflow_template.${folder.id}`,
      'some-bogus-template-id',
    );

    const diag = inspectFolderWorkflowResolution(s.ctx, folder.id);
    expect(diag.storedId).toBe('some-bogus-template-id');
    expect(diag.resolved.kind).toBe('fallback_to_default');
    expect(diag.fellBackBecause).toBe('unknown_template_id');
  });

  it('returns kind=fallback_to_default with workflow_row_not_found when stored ULID matches no row', () => {
    const folder = s.ctx.folders.create('F');
    const fakeUlid = ulid();
    // Direct write — validateFolderWorkflowSelection would reject
    // this because the row doesn't exist.
    s.ctx.settings.set(`auto_code.workflow_template.${folder.id}`, fakeUlid);

    const diag = inspectFolderWorkflowResolution(s.ctx, folder.id);
    expect(diag.storedId).toBe(fakeUlid);
    expect(diag.resolved.kind).toBe('fallback_to_default');
    expect(diag.fellBackBecause).toBe('workflow_row_not_found');
  });

  it('returns null fellBackBecause when stored value defaults to DEFAULT_TEMPLATE_ID (no setting)', () => {
    const folder = s.ctx.folders.create('F');
    // No setting written. readFolderWorkflowTemplate falls back to
    // DEFAULT_TEMPLATE_ID, which IS a known template → resolves cleanly.
    const diag = inspectFolderWorkflowResolution(s.ctx, folder.id);
    expect(diag.resolved.kind).toBe('template');
    expect(diag.fellBackBecause).toBeNull();
  });
});

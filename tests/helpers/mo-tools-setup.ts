import type { ToolContext } from '../../src/server/tools/types.js';
import { openDb } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import { TagsRepository } from '../../src/core/tags/repository.js';
import { RevisionsRepository } from '../../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../../src/core/attachments/repository.js';
import { NoteCommentsRepository } from '../../src/core/notes/comments-repository.js';
import { FtsIndex } from '../../src/core/search/fts.js';
import { VecIndex } from '../../src/core/search/vec.js';
import { HybridSearch } from '../../src/core/search/hybrid.js';
import { Indexer } from '../../src/core/search/indexer.js';
import { NoopEmbeddings } from '../../src/core/embeddings/noop.js';
import { SettingsRepository } from '../../src/core/settings/repository.js';

/**
 * Shared fixtures for the mo-tools scenario suites under
 * `tests/mo-tools/`. The dispatcher tests need only a stub
 * `ToolContext` (`stubCtx`) — they exercise the dispatcher's
 * envelope shapes against inlined test tools, not real handlers.
 * The serialize tests need a real DB-backed context (`buildRealCtx`)
 * because they wire up `tasksListTool` / `notesListTool` /
 * `notesGetTool` / `notesRecentTool` and assert against actual
 * tool returns.
 */

export const stubCtx = (): ToolContext =>
  ({ actor: 'morion-concierge' } as unknown as ToolContext);

export function buildRealCtx(actor = 'morion-concierge'): ToolContext {
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
  return {
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
    actor,
    configDir: '/tmp/morion-test-mo-tools',
  } as unknown as ToolContext;
}

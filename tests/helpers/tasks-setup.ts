import { openDb, type DbHandle } from '../../src/core/db/client.js';
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
import type { ToolContext } from '../../src/server/tools/types.js';
import type { Folder } from '../../src/core/notes/types.js';

/**
 * Shared setup for the tasks (kanban) test suite.
 * Extracted from tests/tasks.test.ts during the 2026-05-16 split
 * (Morion ticket 01KRQSB9KYQ7F9XBPYJZJTS7D7).
 *
 * Builds a full in-memory ToolContext — needed because tasks_* MCP
 * tools touch comments + settings + audit + search index. The bare
 * tests/helpers/notes-repo-setup.ts (notes + folders + tags only) is
 * insufficient for this scope.
 */

export interface Ctx {
  handle: DbHandle;
  tc: ToolContext;
}

export function setup(actor = 'mcp:test-agent'): Ctx {
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
    handle,
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
      actor,
      configDir: '/tmp/morion-test-tasks',
    },
  };
}

export async function createKanbanFolder(ctx: Ctx, name: string): Promise<Folder> {
  const folder = ctx.tc.folders.create(name);
  const updated = ctx.tc.folders.setViewMode(folder.id, 'kanban');
  return updated!;
}

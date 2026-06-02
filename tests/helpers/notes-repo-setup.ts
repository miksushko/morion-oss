import { openDb, type DbHandle } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import { TagsRepository } from '../../src/core/tags/repository.js';

export interface NotesRepoCtx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  tags: TagsRepository;
}

export function setupNotesRepoCtx(): NotesRepoCtx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  return {
    handle,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
    tags: new TagsRepository(handle.db),
  };
}

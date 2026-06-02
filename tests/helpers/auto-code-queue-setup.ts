import { openDb, type DbHandle } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import { AgentQueueRepository } from '../../src/core/auto-code/queue.js';

export interface Ctx {
  handle: DbHandle;
  folders: FoldersRepository;
  notes: NotesRepository;
  queue: AgentQueueRepository;
  /** A single linked-repo path stand-in — the queue treats it as
   *  opaque text, no on-disk validation here (that lives in the
   *  HTTP route, see concierge-http.test.ts). */
  fakeRepo: string;
}

export function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  return {
    handle,
    folders: new FoldersRepository(handle.db),
    notes: new NotesRepository(handle.db, audit),
    queue: new AgentQueueRepository(handle.db),
    fakeRepo: '/tmp/fake-repo-for-queue-tests',
  };
}

export function makeTask(ctx: Ctx, folderId: string, body = '# T\nbody'): string {
  return ctx.notes.create({ body, folderId, source: 'user' }, 'user').id;
}

import { openDb, type DbHandle } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import {
  NoteMoClustersRepository,
  MoClusterQueueRepository,
  MoTopicDecisionsRepository,
} from '../../src/core/concierge/index.js';

/**
 * Shared fixture for the mo-topic-cleanup unit-test suite.
 * Extracted from tests/mo-topic-cleanup.test.ts during the 2026-05-16
 * split (Morion umbrella ticket 01KRQSBM19X6BA3SKR8CYFX0H0).
 */

export interface Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  clusters: NoteMoClustersRepository;
  clusterQueue: MoClusterQueueRepository;
  decisions: MoTopicDecisionsRepository;
}

export function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  return {
    handle,
    audit,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
    clusters: new NoteMoClustersRepository(handle.db),
    clusterQueue: new MoClusterQueueRepository(handle.db),
    decisions: new MoTopicDecisionsRepository(handle.db),
  };
}

export const longBody = (tag: string) =>
  `# ${tag}\n\nA fully-formed ticket body that has more than thirty characters of substantive content. Tag=${tag}.`;

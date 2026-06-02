import type Database from 'better-sqlite3';
import { openDb } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { ConciergeFolderSettingsRepository } from '../../src/core/concierge/folder-settings-repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { SettingsRepository } from '../../src/core/settings/repository.js';
import { WorkflowRunsRepository } from '../../src/core/auto-code/workflows/runs-repository.js';
import { AUTO_CODE_FOLDER_SWEEP_DONE_KEY_PREFIX } from '../../src/server/features/auto-code-tick/index.js';
import type {
  AutoCodeDispatcher,
  UnifiedEnqueueResult,
} from '../../src/server/features/auto-code-factory/index.js';

/**
 * Shared fixture for the auto-code-tick unit-test suite.
 * Extracted from tests/auto-code-tick.test.ts during the 2026-05-16
 * split (Morion umbrella ticket 01KRQSBM19X6BA3SKR8CYFX0H0).
 */

export interface Ctx {
  db: Database.Database;
  notes: NotesRepository;
  folders: FoldersRepository;
  audit: AuditLogger;
  folderSettings: ConciergeFolderSettingsRepository;
  settings: SettingsRepository;
  runsRepo: WorkflowRunsRepository;
  folderId: string;
  enabledFolderId: string;
}

export function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const folders = new FoldersRepository(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const settings = new SettingsRepository(handle.db);
  const runsRepo = new WorkflowRunsRepository(handle.db);

  // Two folders: one auto-code-enabled, one not.
  const enabledFolder = folders.create('Enabled');
  folderSettings.update(enabledFolder.id, {
    enabled: true,
    autoCodeEnabled: true,
    linkedRepoPath: '/tmp/morion-test',
  });
  const disabledFolder = folders.create('Disabled');
  folderSettings.update(disabledFolder.id, { enabled: true });

  return {
    db: handle.db,
    notes,
    folders,
    audit,
    folderSettings,
    settings,
    runsRepo,
    folderId: disabledFolder.id,
    enabledFolderId: enabledFolder.id,
  };
}

export function buildStubDispatcher(
  results: UnifiedEnqueueResult[] | (() => UnifiedEnqueueResult),
): {
  dispatcher: AutoCodeDispatcher;
  calls: Array<{ noteId: string; folderId: string }>;
} {
  const calls: Array<{ noteId: string; folderId: string }> = [];
  let i = 0;
  const dispatcher: AutoCodeDispatcher = {
    isWorkflowRunner: true,
    enqueueTicket: async (noteId, folderId) => {
      calls.push({ noteId, folderId });
      if (typeof results === 'function') return results();
      return results[i++ % results.length];
    },
    cancelTicket: async () => ({ legacy: null, workflowRunIds: [] }),
    cancelFolder: async () => ({ legacy: null, workflowRunIds: [] }),
    inflightOverview: () => ({ count: 0, taskTitles: [] }),
  };
  return { dispatcher, calls };
}

export function folderSweepKey(folderId: string): string {
  return `${AUTO_CODE_FOLDER_SWEEP_DONE_KEY_PREFIX}${folderId}`;
}

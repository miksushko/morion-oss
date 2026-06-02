import { describe, it, expect, beforeEach } from 'vitest';
import { ulid } from 'ulid';

import { openDb, type DbHandle } from '../src/core/db/client.js';
import {
  validateTicketWorkflowAssignment,
  checkActiveRunLock,
} from '../src/server/features/auto-code-factory/ticket-workflow-validation.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { WorkflowsRepository } from '../src/core/auto-code/workflows/workflows-repository.js';
import { WorkflowRunsRepository } from '../src/core/auto-code/workflows/runs-repository.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../src/core/auto-code/workflows/default-autocode.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';

/**
 * Shared validator for per-ticket workflow assignment patches
 * (ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE). The same helper backs both
 * the HTTP `PATCH /api/notes/:id` route AND the MCP `notes_update`
 * tool — the contract MUST stay consistent across both surfaces.
 */

interface Setup {
  handle: DbHandle;
  folders: FoldersRepository;
  notes: NotesRepository;
  wfRepo: WorkflowsRepository;
  runsRepo: WorkflowRunsRepository;
}

function makeSetup(): Setup {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  return {
    handle,
    folders: new FoldersRepository(handle.db),
    notes: new NotesRepository(handle.db, audit),
    wfRepo: new WorkflowsRepository(handle.db),
    runsRepo: new WorkflowRunsRepository(handle.db),
  };
}

describe('validateTicketWorkflowAssignment', () => {
  let s: Setup;
  beforeEach(() => {
    s = makeSetup();
  });

  it('null workflowId is always allowed (clears the override)', () => {
    const res = validateTicketWorkflowAssignment(s.handle.db, 'any', null);
    expect(res.ok).toBe(true);
  });

  it('built-in template id resolves cleanly', () => {
    const folder = s.folders.create('F');
    const res = validateTicketWorkflowAssignment(s.handle.db, folder.id, 'default-v2');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.workflowId).toBe('default-v2');
  });

  it('custom workflow row owned by the folder resolves', () => {
    const folder = s.folders.create('F');
    const row = s.wfRepo.create({
      folderId: folder.id,
      name: 'Custom',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });
    const res = validateTicketWorkflowAssignment(s.handle.db, folder.id, row.id);
    expect(res.ok).toBe(true);
  });

  it('unknown id (no template, no row) returns workflow_not_found', () => {
    const folder = s.folders.create('F');
    const res = validateTicketWorkflowAssignment(s.handle.db, folder.id, ulid());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.error).toBe('workflow_not_found');
  });

  it('custom workflow row owned by ANOTHER folder is rejected', () => {
    const fA = s.folders.create('A');
    const fB = s.folders.create('B');
    const rowB = s.wfRepo.create({
      folderId: fB.id,
      name: 'B',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });
    const res = validateTicketWorkflowAssignment(s.handle.db, fA.id, rowB.id);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.error).toBe('workflow_not_owned_by_folder');
  });

  it('null folderId with non-null workflowId returns ticket_folder_required', () => {
    const res = validateTicketWorkflowAssignment(s.handle.db, null, 'default-v2');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.error).toBe('ticket_folder_required');
  });
});

describe('checkActiveRunLock', () => {
  let s: Setup;
  beforeEach(() => {
    s = makeSetup();
  });

  it('null folderId returns null (no lock)', () => {
    expect(checkActiveRunLock(s.handle.db, null, 'any-task')).toBeNull();
  });

  it('returns null when no run exists for the ticket', () => {
    const folder = s.folders.create('F');
    const note = s.notes.create(
      { body: 'task', folderId: folder.id, source: 'user' },
      'user',
    );
    expect(checkActiveRunLock(s.handle.db, folder.id, note.id)).toBeNull();
  });

  it('returns workflow_locked_during_run when an active run exists', () => {
    const folder = s.folders.create('F');
    const note = s.notes.create(
      { body: 'task', folderId: folder.id, source: 'user' },
      'user',
    );
    // Claim an active workflow_runs row directly
    const claim = s.runsRepo.createRun({
      folderId: folder.id,
      ticketId: note.id,
      workflowId: null,
      graphSnapshot: LEGACY_LINEAR_AUTOCODE_DEFINITION,
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/repo/wt',
      initialStatus: 'running',
    });
    expect(claim.deduped).toBe(false);

    const lock = checkActiveRunLock(s.handle.db, folder.id, note.id);
    expect(lock).not.toBeNull();
    expect(lock?.error).toBe('workflow_locked_during_run');
    if (lock && lock.error === 'workflow_locked_during_run') {
      expect(lock.runId).toBe(claim.run.id);
    }
  });

  it('returns null after the run reaches a terminal state', () => {
    const folder = s.folders.create('F');
    const note = s.notes.create(
      { body: 'task', folderId: folder.id, source: 'user' },
      'user',
    );
    const claim = s.runsRepo.createRun({
      folderId: folder.id,
      ticketId: note.id,
      workflowId: null,
      graphSnapshot: LEGACY_LINEAR_AUTOCODE_DEFINITION,
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/repo/wt',
      initialStatus: 'running',
    });
    s.runsRepo.updateRun(claim.run.id, {
      status: 'done',
      finishedAt: Date.now(),
    });
    expect(checkActiveRunLock(s.handle.db, folder.id, note.id)).toBeNull();
  });
});

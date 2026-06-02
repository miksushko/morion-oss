/**
 * Pins the workflow_runs.schedule_id back-reference contract for
 * Phase 1d-A of the Scheduler epic (01KSX1WJF0TR6949TDQS7Z1TXS).
 *
 * Adds:
 *   * Migration 0041 — workflow_runs.schedule_id column (FK ON DELETE
 *     SET NULL) + partial index on rows with a non-null schedule_id.
 *   * CreateRunInput.scheduleId optional → persisted to row → reflected
 *     in WorkflowRunRow.scheduleId on read.
 *   * Deleting a schedule sets schedule_id to NULL on its historical
 *     runs (preserves history); existing kanban runs (scheduleId=null)
 *     are unaffected.
 *
 * Phase 1d-B (dispatchScheduled in WorkflowRunner) consumes this
 * column; that integration is in a separate ticket-suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { WorkflowRunsRepository } from '../src/core/auto-code/workflows/runs-repository.js';
import { WorkflowSchedulesRepository } from '../src/core/auto-code/schedules/repository.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../src/core/auto-code/workflows/default-autocode.js';

describe('workflow_runs.schedule_id (01KSX1WJF0TR6949TDQS7Z1TXS Phase 1d-A)', () => {
  let handle: DbHandle;
  let db: Database.Database;
  let folders: FoldersRepository;
  let notes: NotesRepository;
  let runs: WorkflowRunsRepository;
  let schedules: WorkflowSchedulesRepository;
  let folderId: string;
  let ticketId: string;

  beforeEach(() => {
    handle = openDb({ path: ':memory:' });
    db = handle.db;
    const audit = new AuditLogger(db);
    folders = new FoldersRepository(db);
    notes = new NotesRepository(db, audit);
    runs = new WorkflowRunsRepository(db);
    schedules = new WorkflowSchedulesRepository(db);
    folderId = folders.create('SchedRunFolder').id;
    ticketId = notes.create(
      { body: 't', folderId, source: 'user' },
      'user',
    ).id;
  });

  afterEach(() => {
    db.close();
  });

  it('persists scheduleId on create and reflects it on read', () => {
    const sched = schedules.create({ folderId, cronExpr: '* * * * *' });
    const result = runs.createRun({
      folderId,
      ticketId,
      workflowId: null,
      graphSnapshot: LEGACY_LINEAR_AUTOCODE_DEFINITION,
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/repo/wt',
      scheduleId: sched.id,
      initialStatus: 'pending',
    });
    expect(result.run.scheduleId).toBe(sched.id);
    // Re-fetch via getRun to confirm the round-trip through row-mapping.
    const fetched = runs.getRun(result.run.id);
    expect(fetched?.scheduleId).toBe(sched.id);
  });

  it('omitting scheduleId defaults to null (kanban-run shape)', () => {
    const result = runs.createRun({
      folderId,
      ticketId,
      workflowId: null,
      graphSnapshot: LEGACY_LINEAR_AUTOCODE_DEFINITION,
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/repo/wt',
      initialStatus: 'pending',
    });
    expect(result.run.scheduleId).toBeNull();
  });

  it('deleting a schedule sets schedule_id to NULL on its historical runs', () => {
    // ON DELETE SET NULL preserves the run row as un-attributed history,
    // not CASCADE — losing run history when a schedule is deleted would
    // surprise users who later wonder "did that workflow ever run".
    const sched = schedules.create({ folderId, cronExpr: '* * * * *' });
    const result = runs.createRun({
      folderId,
      ticketId,
      workflowId: null,
      graphSnapshot: LEGACY_LINEAR_AUTOCODE_DEFINITION,
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/repo/wt',
      scheduleId: sched.id,
      initialStatus: 'done', // terminal so it doesn't block other tests
    });
    expect(result.run.scheduleId).toBe(sched.id);

    schedules.delete(sched.id);

    const fetched = runs.getRun(result.run.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.scheduleId).toBeNull();
  });

  it("dropping the schedule's folder cascades the run (NOT the schedule SET-NULL path)", () => {
    // workflow_runs.folder_id has ON DELETE CASCADE (migration 0028) —
    // deleting the folder DOES delete the run row, regardless of how
    // schedule_id is wired. This is the documented existing behaviour;
    // schedule_id's SET NULL only applies when the SCHEDULE row is
    // deleted, not when the parent folder goes away.
    const sched = schedules.create({ folderId, cronExpr: '* * * * *' });
    const result = runs.createRun({
      folderId,
      ticketId,
      workflowId: null,
      graphSnapshot: LEGACY_LINEAR_AUTOCODE_DEFINITION,
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/repo/wt',
      scheduleId: sched.id,
      initialStatus: 'done',
    });

    folders.delete(folderId);

    expect(runs.getRun(result.run.id)).toBeNull();
  });
});

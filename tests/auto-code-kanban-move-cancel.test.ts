import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { RevisionsRepository } from '../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import { NoteCommentsRepository } from '../src/core/notes/comments-repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import {
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  MoSpendLedgerRepository,
  MoMemoryRepository,
  BudgetTracker,
} from '../src/core/concierge/index.js';
import { buildHttpApp } from '../src/server/bootstrap/http.js';
import { AgentQueueRepository } from '../src/core/auto-code/queue.js';
import { AUTO_CODE_ACTOR } from '../src/core/auto-code/actor-constants.js';

/**
 * Auto-code Phase 2 follow-up — cancel-on-manual-kanban-move.
 *
 * When the user drags a kanban card OUT of an agent-active state
 * (e.g. from `doing` back to `backlog`, or to `done` manually) the
 * orchestrator's in-flight queue row goes stale — the agent is
 * mid-fix on a worktree the user has already moved past. The route
 * hook in `kanban.ts` calls `cancelInFlightForTask` to SIGTERM the
 * process + cancel the row + clean the worktree.
 *
 * These tests exercise the route layer end-to-end with an in-memory
 * DB. Worktree removal is tolerated when the worktree dir doesn't
 * exist on disk (the actual `removeWorktree` helper handles that
 * via `existsSync`); we don't need to seed real worktrees here.
 */

interface Ctx {
  handle: DbHandle;
  app: ReturnType<typeof buildHttpApp>;
  notes: NotesRepository;
  folders: FoldersRepository;
  folderSettings: ConciergeFolderSettingsRepository;
  agentQueue: AgentQueueRepository;
  repoPath: string;
}

function setup(): Ctx {
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
  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const sessions = new ConciergeSessionsRepository(handle.db);
  const cMessages = new ConciergeMessagesRepository(handle.db);
  const moSpendLedger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(moSpendLedger);
  const agentQueue = new AgentQueueRepository(handle.db);
  const configDir = mkdtempSync(join(tmpdir(), 'morion-auto-code-cancel-'));
  // Repo dir doesn't need to be a real git repo — the cancel hook
  // reads `linked_repo_path` to pass to removeWorktree, which
  // tolerates a missing worktree dir gracefully (existsSync check).
  const repoPath = mkdtempSync(join(tmpdir(), 'morion-auto-code-cancel-repo-'));

  const app = buildHttpApp({
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
    configDir,
    concierge: {
      folderSettings,
      sessions,
      messages: cMessages,
      moSpendLedger,
      moMemory,
      budget,
    },
  });

  return { handle, app, notes, folders, folderSettings, agentQueue, repoPath };
}

function setupAutoCodeFolder(ctx: Ctx): { folderId: string } {
  const folder = ctx.folders.create('Auto-code folder');
  ctx.folders.setViewMode(folder.id, 'kanban');
  ctx.folderSettings.update(folder.id, {
    linkedRepoPath: ctx.repoPath,
    autoCodeEnabled: true,
  });
  return { folderId: folder.id };
}

function seedInFlightRow(
  ctx: Ctx,
  folderId: string,
  taskId: string,
): string {
  const enq = ctx.agentQueue.enqueue({
    folderId,
    taskId,
    repoPath: ctx.repoPath,
  });
  if (enq.kind !== 'inserted') throw new Error('seed enqueue failed');
  ctx.agentQueue.claimNext(folderId);
  ctx.agentQueue.transition(enq.row.id, 'fix_running', 'fix_running', {
    worktreeName: 'auto-test-wt',
  });
  return enq.row.id;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('POST /api/notes/:id/kanban-move — auto-code drift cancel', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('cancels in-flight row when user drags from doing → backlog', async () => {
    const { folderId } = setupAutoCodeFolder(ctx);
    const task = ctx.notes.create(
      { body: '# T', folderId, source: 'user', status: 'doing' },
      'user',
    );
    const rowId = seedInFlightRow(ctx, folderId, task.id);

    const res = await ctx.app.request(
      `/api/notes/${task.id}/kanban-move`,
      json({ status: 'backlog' }),
    );
    expect(res.status).toBe(200);
    expect(ctx.agentQueue.getById(rowId)?.state).toBe('cancelled');
    expect(ctx.agentQueue.getById(rowId)?.lastError).toContain('kanban-move:user');
  });

  it('cancels in-flight row when user drags to done manually', async () => {
    const { folderId } = setupAutoCodeFolder(ctx);
    const task = ctx.notes.create(
      { body: '# T', folderId, source: 'user', status: 'doing' },
      'user',
    );
    const rowId = seedInFlightRow(ctx, folderId, task.id);

    const res = await ctx.app.request(
      `/api/notes/${task.id}/kanban-move`,
      json({ status: 'done' }),
    );
    expect(res.status).toBe(200);
    expect(ctx.agentQueue.getById(rowId)?.state).toBe('cancelled');
  });

  it('does NOT cancel when the move LANDS in todo (entry state for the agent)', async () => {
    const { folderId } = setupAutoCodeFolder(ctx);
    const task = ctx.notes.create(
      { body: '# T', folderId, source: 'user', status: 'backlog' },
      'user',
    );
    const rowId = seedInFlightRow(ctx, folderId, task.id);

    const res = await ctx.app.request(
      `/api/notes/${task.id}/kanban-move`,
      json({ status: 'todo' }),
    );
    expect(res.status).toBe(200);
    // Row stays in fix_running.
    expect(ctx.agentQueue.getById(rowId)?.state).toBe('fix_running');
  });

  it('does NOT cancel when the move actor is mcp:auto-code itself (no self-cancel loop)', async () => {
    const { folderId } = setupAutoCodeFolder(ctx);
    const task = ctx.notes.create(
      { body: '# T', folderId, source: 'user', status: 'doing' },
      'user',
    );
    const rowId = seedInFlightRow(ctx, folderId, task.id);

    // Bypass the HTTP route and call moveToKanban directly with the
    // auto-code actor — the orchestrator does this on approve →
    // done. Since no kanban-move route call happened, the cancel
    // hook never fires.
    ctx.notes.moveToKanban(task.id, 'done', null, AUTO_CODE_ACTOR);
    // Row state is whatever the orchestrator's transition put it in
    // (in this test we don't run the orchestrator, so state stays
    // fix_running) — the important thing is that NO unrelated
    // cancel happened.
    expect(ctx.agentQueue.getById(rowId)?.state).toBe('fix_running');
    // Sanity: the move did happen.
    expect(ctx.notes.getById(task.id)?.status).toBe('done');
  });

  it('does nothing when the folder has auto-code disabled', async () => {
    const folder = ctx.folders.create('Plain folder');
    ctx.folders.setViewMode(folder.id, 'kanban');
    // No autoCodeEnabled / linkedRepoPath wired up.
    const task = ctx.notes.create(
      { body: '# T', folderId: folder.id, source: 'user', status: 'doing' },
      'user',
    );
    // Even if there's an orphan queue row (defensive), the hook bails
    // out because folder settings disable auto-code.
    const enq = ctx.agentQueue.enqueue({
      folderId: folder.id,
      taskId: task.id,
      repoPath: '/tmp/whatever',
    });
    if (enq.kind !== 'inserted') throw new Error('seed enqueue failed');
    const res = await ctx.app.request(
      `/api/notes/${task.id}/kanban-move`,
      json({ status: 'backlog' }),
    );
    expect(res.status).toBe(200);
    // Row left untouched (orphan defensive check).
    expect(ctx.agentQueue.getById(enq.row.id)?.state).toBe('pending');
  });

  it('is a no-op when the task has no in-flight queue row', async () => {
    const { folderId } = setupAutoCodeFolder(ctx);
    const task = ctx.notes.create(
      { body: '# T', folderId, source: 'user', status: 'doing' },
      'user',
    );
    // No queue row seeded for this task.
    const res = await ctx.app.request(
      `/api/notes/${task.id}/kanban-move`,
      json({ status: 'backlog' }),
    );
    expect(res.status).toBe(200);
    expect(ctx.agentQueue.listInFlightForFolder(folderId).length).toBe(0);
  });
});

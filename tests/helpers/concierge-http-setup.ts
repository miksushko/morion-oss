import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  MoSpendLedgerRepository,
  MoMemoryRepository,
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  BudgetTracker,
} from '../../src/core/concierge/index.js';
import { buildHttpApp } from '../../src/server/bootstrap/http.js';

/**
 * Shared test setup for the concierge HTTP route suites
 * (originally inlined in tests/concierge-http.test.ts before the
 * 2026-05-16 split — Morion ticket 01KRJZ050EX392K9NY7GAKA1JE).
 *
 * Builds an in-memory SQLite DB + all the concierge repositories +
 * a buildHttpApp instance wired against them. Each scenario file
 * calls `setup()` in `beforeEach` to start from a clean state.
 */


export function activatePro(_settings: SettingsRepository): void {
  // no-op: open-source build has no license tier (kept for call-site compatibility)
}

export interface Ctx {
  handle: DbHandle;
  app: ReturnType<typeof buildHttpApp>;
  settings: SettingsRepository;
  folders: FoldersRepository;
  notes: NotesRepository;
  concierge: {
    folderSettings: ConciergeFolderSettingsRepository;
    sessions: ConciergeSessionsRepository;
    messages: ConciergeMessagesRepository;
    budget: BudgetTracker;
    moSpendLedger: MoSpendLedgerRepository;
    moMemory: MoMemoryRepository;
  };
}

export function setup(): Ctx {
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
  const configDir = mkdtempSync(join(tmpdir(), 'morion-concierge-http-'));

  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const sessions = new ConciergeSessionsRepository(handle.db);
  const cMessages = new ConciergeMessagesRepository(handle.db);
  const moSpendLedger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(moSpendLedger);

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
    concierge: { folderSettings, sessions, messages: cMessages, moSpendLedger, moMemory, budget },
  });

  return {
    handle,
    app,
    settings,
    folders,
    notes,
    concierge: { folderSettings, sessions, messages: cMessages, moSpendLedger, moMemory, budget },
  };
}

/** Body builder for fetch-style requests against the in-memory app. */
export const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Minimal valid workflow definition shared by the auto-code/workflows
 *  CRUD + seeding test suites. Single cli_agent stage, no branches. */
export const SIMPLE_DEFINITION = {
  schemaVersion: 1,
  name: 'Test wf',
  description: '',
  stages: [
    {
      id: 'fix',
      kind: 'cli_agent',
      agent: 'claude',
      promptTemplate: 'do work {{ticket.id}}',
      maxBudgetUsd: 1,
      maxAttempts: 1,
      allowedTools: ['Read'],
    },
  ],
  edges: [],
};

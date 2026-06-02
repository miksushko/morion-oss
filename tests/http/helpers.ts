/**
 * Shared setup + license helpers for the HTTP-route test suite.
 *
 * The original tests/http.test.ts (1543 LOC, 75 tests, 13 top-level
 * describes by route family) is split into per-route test files
 * (`tests/http-<route>.test.ts`) that all import this module.
 * Vitest's `include: tests/**\/*.test.ts` skips this file.
 *
 * `setup()` boots an in-memory hono app over `:memory:` SQLite. We use
 * the embedded NoopEmbeddings provider so the test never touches the
 * network or downloads a model. Routes are exercised via
 * `app.request()`, never a real port. Each setup() gets its own
 * mkdtemp config dir for attachments so parallel test runs don't
 * stomp each other.
 *
 * `activateProHttp(settings)` is a retained no-op from the pre-OSS era
 * (there is no license tier any more — every feature is free); it stays
 * so the ~30 call sites that set up a "Pro" workspace keep compiling.
 */
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
import { buildHttpApp } from '../../src/server/bootstrap/http.js';


export function activateProHttp(_settings: SettingsRepository): void {
  // no-op: open-source build has no license tier (kept for call-site compatibility)
}

export interface Ctx {
  handle: DbHandle;
  app: ReturnType<typeof buildHttpApp>;
  tags: TagsRepository;
  notes: NotesRepository;
  folders: FoldersRepository;
  settings: SettingsRepository;
  revisions: RevisionsRepository;
  comments: NoteCommentsRepository;
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
  const configDir = mkdtempSync(join(tmpdir(), 'morion-http-test-'));
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
  });
  return { handle, app, tags, notes, folders, settings, revisions, comments };
}

export const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const patchJson = (body: unknown): RequestInit => ({
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

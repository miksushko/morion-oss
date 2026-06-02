import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { buildHttpApp } from '../src/server/bootstrap/http.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * C1 auth token gate. The sidecar in production reads MORION_API_TOKEN
 * from its env (set by src-tauri/src/main.rs at app launch), then every
 * /api/* request (except /api/health) must carry a matching X-Morion-Token
 * header. This blocks local malware and DNS-rebinding attacks that
 * would otherwise inherit loopback access to the note DB.
 *
 * Dev mode (empty token) skips the gate — `npm run dev` and vitest-style
 * integration tests keep working unchanged.
 */

const TOKEN = 'a'.repeat(64);
let handle: DbHandle;
const originalToken = process.env.MORION_API_TOKEN;

function buildAppWithAuth(): ReturnType<typeof buildHttpApp> {
  handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const revisions = new RevisionsRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const search = new HybridSearch(handle.db, fts, vec, embeddings);
  const indexer = new Indexer(vec, embeddings);
  // settings + audit became required by the v0.98 license/permission
  // routes, and by the 2026-04-16 N2 fix that gates the notes count
  // through `isPro(ctx.settings)`. Tests that predate those changes
  // worked by accident — pass them through for completeness.
  const settings = new SettingsRepository(handle.db);
  const attachments = new AttachmentsRepository(handle.db);
  const comments = new NoteCommentsRepository(handle.db);
  const configDir = mkdtempSync(join(tmpdir(), 'morion-auth-test-'));
  return buildHttpApp({
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
}

describe('C1 auth token gate', () => {
  beforeEach(() => {
    process.env.MORION_API_TOKEN = TOKEN;
  });
  afterEach(() => {
    handle?.db.close();
    if (originalToken === undefined) delete process.env.MORION_API_TOKEN;
    else process.env.MORION_API_TOKEN = originalToken;
  });

  it('rejects /api/notes without X-Morion-Token → 401', async () => {
    const app = buildAppWithAuth();
    const res = await app.request('/api/notes');
    expect(res.status).toBe(401);
  });

  it('accepts /api/notes with the correct token', async () => {
    const app = buildAppWithAuth();
    const res = await app.request('/api/notes', {
      headers: { 'X-Morion-Token': TOKEN },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a token of the wrong length without leaking timing info', async () => {
    const app = buildAppWithAuth();
    const res = await app.request('/api/notes', {
      headers: { 'X-Morion-Token': 'short' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a token that differs in one character (constant-time compare)', async () => {
    const app = buildAppWithAuth();
    const wrong = 'b' + 'a'.repeat(63); // same length, one char different
    const res = await app.request('/api/notes', {
      headers: { 'X-Morion-Token': wrong },
    });
    expect(res.status).toBe(401);
  });

  it('exempts /api/health so the Tauri shell can probe liveness before the token IPC resolves', async () => {
    const app = buildAppWithAuth();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('allows Windows Tauri WebView2 preflight from http://tauri.localhost', async () => {
    const app = buildAppWithAuth();
    const res = await app.request('/api/settings/accept-terms', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://tauri.localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-morion-token',
        'Access-Control-Request-Private-Network': 'true',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://tauri.localhost');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Morion-Token');
    expect(res.headers.get('Access-Control-Allow-Private-Network')).toBe('true');
  });

  it('adds CORS headers to real Windows Tauri WebView2 API responses', async () => {
    const app = buildAppWithAuth();
    const res = await app.request('/api/settings', {
      headers: {
        Origin: 'http://tauri.localhost',
        'X-Morion-Token': TOKEN,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://tauri.localhost');
    expect(res.headers.get('Access-Control-Allow-Private-Network')).toBe('true');
  });
});

describe('C1 auth disabled in dev mode (empty MORION_API_TOKEN)', () => {
  beforeEach(() => {
    delete process.env.MORION_API_TOKEN;
  });
  afterEach(() => {
    handle?.db.close();
    if (originalToken !== undefined) process.env.MORION_API_TOKEN = originalToken;
  });

  it('allows /api/notes without any token when env is unset', async () => {
    const app = buildAppWithAuth();
    const res = await app.request('/api/notes');
    expect(res.status).toBe(200);
  });
});

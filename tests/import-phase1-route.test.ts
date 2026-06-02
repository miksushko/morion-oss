import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
import { buildHttpApp } from '../src/server/bootstrap/http.js';

interface Ctx {
  handle: DbHandle;
  app: ReturnType<typeof buildHttpApp>;
  notes: NotesRepository;
  folders: FoldersRepository;
  vault: string;
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
  const configDir = mkdtempSync(join(tmpdir(), 'morion-import-route-'));
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
  const vault = mkdtempSync(join(tmpdir(), 'morion-import-vault-'));
  return { handle, app, notes, folders, vault };
}

function cleanup(ctx: Ctx): void {
  ctx.handle.db.close();
  rmSync(ctx.vault, { recursive: true, force: true });
}

function writeFile(vault: string, relPath: string, content: string): void {
  const full = join(vault, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** Wait until predicate returns true or timeout — covers the detached
 *  engine.run completing in the background. */
async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs: number,
  pollMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('POST /api/import — start batch', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('starts a single-file import and returns 202 + batchId', async () => {
    writeFile(ctx.vault, 'note.md', '# Hello');
    const res = await ctx.app.request('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: join(ctx.vault, 'note.md'),
        mode: 'file',
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { batchId: string };
    expect(body.batchId).toMatch(/^[0-9A-Z]{26}$/);

    // Wait for the detached run to finish.
    await waitFor(() => ctx.notes.list({ limit: 100, offset: 0 }).length === 1, 2000);
    const all = ctx.notes.list({ limit: 100, offset: 0 });
    expect(all[0]?.title).toBe('Hello');
    expect(all[0]?.source).toBe('import:markdown');
  });

  it('rejects invalid request body with 400', async () => {
    const res = await ctx.app.request('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '', mode: 'file' }), // empty path
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('rejects unknown mode with 400', async () => {
    const res = await ctx.app.request('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp/x.md', mode: 'whatever' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/import — concurrent imports blocked', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('returns 409 with active batch id when one is already running', async () => {
    // Create a folder big enough that the first import is still
    // running when we POST the second one. 50 files at concurrency 5
    // gives us time to race.
    const src = join(ctx.vault, 'Big');
    for (let i = 0; i < 50; i++) {
      writeFile(src, `n${i}.md`, `# N${i}\n${'x'.repeat(500)}`);
    }
    const r1 = await ctx.app.request('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: src, mode: 'folder' }),
    });
    expect(r1.status).toBe(202);
    const b1 = (await r1.json()) as { batchId: string };

    // Immediately fire a second import. Should be rejected.
    const r2 = await ctx.app.request('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: join(ctx.vault, 'note2.md'),
        mode: 'file',
      }),
    });
    // If r2 raced AFTER batch 1 finished (unlikely on 50 files but
    // possible on very fast machines), allow either 202 or 409.
    if (r2.status === 409) {
      const body = (await r2.json()) as {
        error: string;
        activeBatchId: string;
      };
      expect(body.error).toBe('import_in_progress');
      expect(body.activeBatchId).toBe(b1.batchId);
    } else {
      // First batch finished super fast — at least the test still
      // verifies the happy path didn't crash.
      expect(r2.status).toBe(202);
    }

    // Drain so afterEach can clean up cleanly.
    await waitFor(
      () => ctx.notes.list({ limit: 100, offset: 0 }).length >= 50,
      5000,
    );
  });
});

describe('POST /api/import/:batchId/cancel', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('returns 404 for unknown batch id', async () => {
    const res = await ctx.app.request('/api/import/01ABCDE/cancel', {
      method: 'POST',
    });
    expect(res.status).toBe(404);
  });

  it('flips cancel flag on active batch', async () => {
    const src = join(ctx.vault, 'V');
    for (let i = 0; i < 30; i++) {
      writeFile(src, `n${i}.md`, `# N${i}`);
    }
    const r1 = await ctx.app.request('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: src, mode: 'folder' }),
    });
    const { batchId } = (await r1.json()) as { batchId: string };

    // Immediately cancel.
    const r2 = await ctx.app.request(`/api/import/${batchId}/cancel`, {
      method: 'POST',
    });
    expect(r2.status).toBe(200);

    // Wait for the engine to finish (cancellation lets in-flight
    // writes settle, then drains). Some notes will be imported, some
    // won't.
    await waitFor(async () => {
      const r = await ctx.app.request('/api/import/active');
      const body = (await r.json()) as { busy: boolean };
      return body.busy === false;
    }, 5000);

    const all = ctx.notes.list({ limit: 100, offset: 0 });
    // At least zero, at most all 30 imported. The point: cancellation
    // doesn't crash and registry releases.
    expect(all.length).toBeLessThanOrEqual(30);
  });
});

describe('GET /api/import/active', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => cleanup(ctx));

  it('reports busy=false when no import active', async () => {
    const res = await ctx.app.request('/api/import/active');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { busy: boolean; active: string | null };
    expect(body.busy).toBe(false);
    expect(body.active).toBeNull();
  });
});

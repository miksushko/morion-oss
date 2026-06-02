/**
 * Regression: HTTP `/api/search` filter plumbing for `includeArchived`
 * and date range bounds. The SQL-layer behaviour is covered in
 * `search.test.ts`; this file pins the route's zod schema + param
 * forwarding so a refactor can't drop a filter on the wire.
 *
 * Also exercises the bug fix where unscoped searches used to skip
 * `applyFilters` entirely and leak archived notes through the keyword
 * path. After the fix, default behaviour excludes archived even when
 * no folderId/tag is set, and clients have to opt in via
 * `?includeArchived=true`.
 */
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
import { buildHttpApp } from '../src/server/bootstrap/http.js';

interface Ctx {
  handle: DbHandle;
  app: ReturnType<typeof buildHttpApp>;
  notes: NotesRepository;
  folders: FoldersRepository;
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
  const configDir = mkdtempSync(join(tmpdir(), 'morion-search-filters-'));
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
  return { handle, app, notes, folders };
}

async function searchHits(
  app: Ctx['app'],
  q: string,
  extra: Record<string, string> = {},
): Promise<Array<{ note: { id: string; archivedAt: number | null; createdAt: number } }>> {
  const params = new URLSearchParams({ q, ...extra });
  const res = await app.request(`/api/search?${params.toString()}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Array<{
    note: { id: string; archivedAt: number | null; createdAt: number };
  }>;
}

describe('GET /api/search — filter forwarding', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('archived notes are excluded by default (unscoped query — bug-fix regression)', async () => {
    const live = ctx.notes.create({ body: '# live note\n\nsqlite virtual table', source: 'user' }, 'user');
    const archived = ctx.notes.create(
      { body: '# archived note\n\nsqlite stale row', source: 'user' },
      'user',
    );
    ctx.notes.archive(archived.id, 'user');
    const hits = await searchHits(ctx.app, 'sqlite');
    const ids = hits.map((h) => h.note.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(archived.id);
  });

  it('?includeArchived=true brings archived notes back', async () => {
    const archived = ctx.notes.create(
      { body: '# archived note\n\nsqlite stale row', source: 'user' },
      'user',
    );
    ctx.notes.archive(archived.id, 'user');
    const hits = await searchHits(ctx.app, 'sqlite', { includeArchived: 'true' });
    expect(hits.map((h) => h.note.id)).toContain(archived.id);
  });

  it('?includeArchived=false is treated as default (excluded)', async () => {
    const archived = ctx.notes.create(
      { body: '# archived note\n\nsqlite stale row', source: 'user' },
      'user',
    );
    ctx.notes.archive(archived.id, 'user');
    const hits = await searchHits(ctx.app, 'sqlite', { includeArchived: 'false' });
    expect(hits.map((h) => h.note.id)).not.toContain(archived.id);
  });

  it('?createdAfter filters out older notes', async () => {
    const old = ctx.notes.create({ body: '# older\n\nsqlite stale', source: 'user' }, 'user');
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    const fresh = ctx.notes.create({ body: '# fresh\n\nsqlite new', source: 'user' }, 'user');
    const hits = await searchHits(ctx.app, 'sqlite', { createdAfter: String(cutoff) });
    const ids = hits.map((h) => h.note.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(old.id);
  });

  it('?createdBefore filters out newer notes', async () => {
    const old = ctx.notes.create({ body: '# older\n\nsqlite stale', source: 'user' }, 'user');
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    const fresh = ctx.notes.create({ body: '# fresh\n\nsqlite new', source: 'user' }, 'user');
    const hits = await searchHits(ctx.app, 'sqlite', { createdBefore: String(cutoff) });
    const ids = hits.map((h) => h.note.id);
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(fresh.id);
  });

  it('?updatedAfter picks up edits, not just creations', async () => {
    const note = ctx.notes.create(
      { body: '# n\n\nsqlite stale before edit', source: 'user' },
      'user',
    );
    await new Promise((r) => setTimeout(r, 5));
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    ctx.notes.update(note.id, { body: '# n\n\nsqlite refreshed body' }, 'user');
    const hits = await searchHits(ctx.app, 'sqlite', { updatedAfter: String(cutoff) });
    expect(hits.map((h) => h.note.id)).toContain(note.id);
  });

  it('id-shortcut respects the archive filter (no opt-in → archived id hidden)', async () => {
    const archived = ctx.notes.create(
      { body: '# archived target\n\nbody text', source: 'user' },
      'user',
    );
    ctx.notes.archive(archived.id, 'user');
    const hitsWithoutOptIn = await searchHits(ctx.app, archived.id);
    expect(hitsWithoutOptIn.map((h) => h.note.id)).not.toContain(archived.id);
    const hitsWithOptIn = await searchHits(ctx.app, archived.id, { includeArchived: 'true' });
    expect(hitsWithOptIn[0]?.note.id).toBe(archived.id);
  });

  it('id-shortcut respects the date filter', async () => {
    const note = ctx.notes.create(
      { body: '# date target\n\nbody', source: 'user' },
      'user',
    );
    const future = Date.now() + 60_000;
    const hits = await searchHits(ctx.app, note.id, { createdAfter: String(future) });
    expect(hits.map((h) => h.note.id)).not.toContain(note.id);
  });

  // Defence-in-depth invariant: every layer that returns note ids
  // enforces `deleted_at IS NULL` (audit N18, see hybrid.ts comment).
  // The ULID shortcut used to skip this — `getById(..., { includeTrashed: true })`
  // plus a LIKE prefix without a deleted_at filter — and could return
  // soft-deleted notes that the keyword path would never surface.
  it('id-shortcut never returns trashed notes (full ULID)', async () => {
    const note = ctx.notes.create(
      { body: '# trashed target\n\nbody about trash', source: 'user' },
      'user',
    );
    ctx.notes.delete(note.id, 'user');
    const hits = await searchHits(ctx.app, note.id);
    expect(hits.map((h) => h.note.id)).not.toContain(note.id);
    // Even with includeArchived opt-in — trashed is a separate state,
    // never opt-in via search.
    const hitsArchived = await searchHits(ctx.app, note.id, { includeArchived: 'true' });
    expect(hitsArchived.map((h) => h.note.id)).not.toContain(note.id);
  });

  it('id-shortcut never returns trashed notes (prefix LIKE path)', async () => {
    const note = ctx.notes.create(
      { body: '# trashed prefix\n\nbody', source: 'user' },
      'user',
    );
    ctx.notes.delete(note.id, 'user');
    // 8-char prefix triggers the LIKE path, not the full-ULID lookup.
    const prefix = note.id.slice(0, 8);
    const hits = await searchHits(ctx.app, prefix);
    expect(hits.map((h) => h.note.id)).not.toContain(note.id);
  });

  it('id-shortcut excludes notes inside an archived folder by default', async () => {
    const folder = ctx.folders.create('archived parent');
    const note = ctx.notes.create(
      { body: '# kid in archived folder\n\nbody', folderId: folder.id, source: 'user' },
      'user',
    );
    // Archive the FOLDER, not the note. The note's own archivedAt stays null.
    ctx.folders.setArchived(folder.id, true);
    const hits = await searchHits(ctx.app, note.id);
    expect(hits.map((h) => h.note.id)).not.toContain(note.id);
  });

  it('id-shortcut surfaces notes-in-archived-folders when includeArchived is true (matches keyword path)', async () => {
    const folder = ctx.folders.create('archived parent');
    const note = ctx.notes.create(
      { body: '# kid in archived folder\n\nbody', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.folders.setArchived(folder.id, true);
    const hits = await searchHits(ctx.app, note.id, { includeArchived: 'true' });
    expect(hits[0]?.note.id).toBe(note.id);
  });
});

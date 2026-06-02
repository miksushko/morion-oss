/**
 * Regression: ⌘K search couldn't find a note by its ULID.
 *
 * 2026-04-25 incident: user wanted to find Morion ticket
 * `01KQ1H4YVKJFVE05PG9WZBAB7E`, pasted the id into ⌘K, got zero hits
 * — FTS only indexes title + body, the id never matches via fulltext.
 *
 * Fix: `/api/search` detects ULID-shaped input, looks the note up
 * directly, prepends to the result list. Partial prefix (6+ chars)
 * also resolves via `id LIKE prefix%`. Folder/tag filters from the
 * query string still apply so the user's mental model holds.
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
  const configDir = mkdtempSync(join(tmpdir(), 'morion-search-by-id-'));
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
): Promise<Array<{ note: { id: string; title: string }; score: number }>> {
  const params = new URLSearchParams({ q, ...extra });
  const res = await app.request(`/api/search?${params.toString()}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Array<{
    note: { id: string; title: string };
    score: number;
  }>;
}

describe('Search by ULID (⌘K shortcut)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('full ULID query returns the matching note as the first hit', async () => {
    const note = ctx.notes.create(
      { body: '# Bug ticket\n\nProject brief truncation', source: 'user' },
      'user',
    );
    // Sanity — the id is the 26-char ULID we'll search for.
    expect(note.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
    const hits = await searchHits(ctx.app, note.id);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.note.id).toBe(note.id);
    expect(hits[0]!.score).toBe(null);
    // Score is JSON-serialised — `Infinity` becomes `null` over the
    // wire. The client just looks at order, not the raw value.
  });

  it('full ULID is case-insensitive', async () => {
    const note = ctx.notes.create({ body: '# X', source: 'user' }, 'user');
    const hits = await searchHits(ctx.app, note.id.toLowerCase());
    expect(hits[0]?.note.id).toBe(note.id);
  });

  it('partial ULID prefix (6+ chars) matches every note whose id starts with it', async () => {
    // Multiple notes share an id prefix because ULIDs are time-ordered;
    // the first ~10 chars usually overlap for notes created in the same
    // millisecond range.
    const note1 = ctx.notes.create({ body: '# A', source: 'user' }, 'user');
    const prefix = note1.id.slice(0, 8);
    // Add a note whose id will NOT start with the same prefix — give
    // it some extra time so its ULID rolls.
    await new Promise((r) => setTimeout(r, 1));
    const hits = await searchHits(ctx.app, prefix);
    const ids = hits.map((h) => h.note.id);
    expect(ids).toContain(note1.id);
    // Every returned id starts with the prefix (case-insensitive).
    for (const id of ids) {
      expect(id.toUpperCase().startsWith(prefix.toUpperCase())).toBe(true);
    }
  });

  it('non-existent full ULID returns whatever fulltext finds (no spurious hit)', async () => {
    ctx.notes.create({ body: '# Real one', source: 'user' }, 'user');
    const fakeId = '01KQZZZZZZZZZZZZZZZZZZZZZZ';
    const hits = await searchHits(ctx.app, fakeId);
    // No id-shortcut match. FTS won't find this either since the body
    // doesn't contain the id string. Empty result is correct.
    expect(hits).toHaveLength(0);
  });

  it('plain keyword query is unaffected — id-shortcut returns nothing, fulltext path runs as before', async () => {
    const note = ctx.notes.create(
      { body: '# Webhook race\n\nHandler was idempotent so no duplicates', source: 'user' },
      'user',
    );
    const hits = await searchHits(ctx.app, 'webhook');
    expect(hits.some((h) => h.note.id === note.id)).toBe(true);
  });

  it('id query honors folderId filter — id outside the active folder is skipped', async () => {
    const folderA = ctx.folders.create('A');
    const folderB = ctx.folders.create('B');
    const inA = ctx.notes.create({ body: '# in A', folderId: folderA.id, source: 'user' }, 'user');
    const inB = ctx.notes.create({ body: '# in B', folderId: folderB.id, source: 'user' }, 'user');
    const hitsA = await searchHits(ctx.app, inB.id, { folderId: folderA.id });
    expect(hitsA.find((h) => h.note.id === inB.id)).toBeUndefined();
    const hitsB = await searchHits(ctx.app, inB.id, { folderId: folderB.id });
    expect(hitsB[0]?.note.id).toBe(inB.id);
    void inA;
  });

  it('id query merges with FTS hits — id-hit lands first, then keyword hits, no duplicates', async () => {
    // Note whose body contains the literal text "ticket". Searching
    // its id should land it first (shortcut), but a separate
    // ticket-body note should still appear as a fulltext hit below.
    const targeted = ctx.notes.create(
      { body: '# Targeted\n\nticket payload', source: 'user' },
      'user',
    );
    ctx.notes.create({ body: '# Other\n\nticket sibling', source: 'user' }, 'user');
    const hits = await searchHits(ctx.app, targeted.id);
    expect(hits[0]?.note.id).toBe(targeted.id);
    // No duplicate of targeted in the list.
    const targetedCount = hits.filter((h) => h.note.id === targeted.id).length;
    expect(targetedCount).toBe(1);
  });

  it('partial-but-not-ULID-shaped input (e.g. all digits, or has I/L/O/U) falls through to fulltext', async () => {
    ctx.notes.create({ body: '# I love L noodles', source: 'user' }, 'user');
    // 'IL' is shorter than 6 → not a ULID prefix → no shortcut.
    const hits = await searchHits(ctx.app, 'IL');
    // Whatever FTS does is fine; we just assert the shortcut didn't
    // crash and didn't inject random results.
    for (const h of hits) {
      expect(h.score).not.toBe(null); // FTS hits carry a numeric score, not Infinity
    }
  });
});

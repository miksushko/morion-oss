import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import type { EmbeddingProvider } from '../src/core/embeddings/provider.js';

/**
 * 15-note fixture spanning three topical clusters. Expected top results are
 * hand-curated against the body text so the assertions stay deterministic
 * regardless of embedding availability.
 */
const FIXTURE: { title: string; body: string; folder?: string; tags?: string[] }[] = [
  {
    title: 'SQLite FTS5 basics',
    body: '# SQLite FTS5 basics\n\nFTS5 is a virtual table module in SQLite that provides keyword search with bm25 ranking.',
    folder: 'tech',
    tags: ['sqlite', 'search'],
  },
  {
    title: 'Porter tokenizer notes',
    body: '# Porter tokenizer notes\n\nThe porter tokenizer stems English words so that "searching" and "search" collapse to the same token.',
    folder: 'tech',
    tags: ['sqlite'],
  },
  {
    title: 'Hybrid retrieval with RRF',
    body: '# Hybrid retrieval with RRF\n\nReciprocal Rank Fusion combines rankings from different retrievers. Good for mixing BM25 with vector search.',
    folder: 'tech',
    tags: ['search'],
  },
  {
    title: 'Embeddings via Ollama',
    body: '# Embeddings via Ollama\n\nRunning nomic embed text locally through Ollama gives a 768 dimensional vector per chunk.',
    folder: 'tech',
    tags: ['embeddings'],
  },
  {
    title: 'TypeScript strict mode',
    body: '# TypeScript strict mode\n\nStrict mode catches implicit any and null errors at compile time. Always enable it in new projects.',
    folder: 'tech',
    tags: ['typescript'],
  },
  {
    title: 'CodeMirror 6 decorations',
    body: '# CodeMirror 6 decorations\n\nA ViewPlugin can add decorations to hide markdown syntax when the caret leaves the current line.',
    folder: 'tech',
    tags: ['editor'],
  },
  {
    title: 'Apple Notes migration idea',
    body: '# Apple Notes migration idea\n\nExport Apple Notes as plaintext and import them into a local markdown vault with frontmatter.',
    folder: 'ideas',
    tags: ['notes'],
  },
  {
    title: 'Grocery list',
    body: '# Grocery list\n\nMilk, eggs, sourdough bread, olive oil, parmesan, basil, tomatoes.',
    folder: 'personal',
    tags: ['shopping'],
  },
  {
    title: 'Weekend trip to Lisbon',
    body: '# Weekend trip to Lisbon\n\nBook the hotel near Alfama, try the pastel de nata, walk the tram 28 route on Saturday morning.',
    folder: 'personal',
    tags: ['travel'],
  },
  {
    title: 'Meeting with Alice',
    body: '# Meeting with Alice\n\nDiscussed the roadmap, agreed on shipping the MCP server first and the editor polish in the second sprint.',
    folder: 'work',
    tags: ['meetings'],
  },
  {
    title: 'Book notes: Deep Work',
    body: '# Book notes: Deep Work\n\nCal Newport argues that deliberate focus is a superpower in a distracted economy.',
    folder: 'reading',
    tags: ['books'],
  },
  {
    title: 'Vector databases overview',
    body: '# Vector databases overview\n\nPinecone, Weaviate, Qdrant and sqlite-vec all expose approximate nearest neighbor search over dense vectors.',
    folder: 'tech',
    tags: ['search', 'embeddings'],
  },
  {
    title: 'Daily journal 2026-01-15',
    body: '# Daily journal 2026-01-15\n\nSlept poorly. Morning run at 7am. Started drafting the product brief for the notebook project.',
    folder: 'journal',
    tags: ['journal'],
  },
  {
    title: 'Gift ideas for mom',
    body: '# Gift ideas for mom\n\nA ceramic mug, the new Murakami novel, a bouquet of peonies delivered on Sunday.',
    folder: 'personal',
    tags: ['gifts'],
  },
  {
    title: 'Recipe: pasta alla norma',
    body: '# Recipe: pasta alla norma\n\nEggplant, tomatoes, ricotta salata, basil, garlic, pasta. Fry the eggplant until golden.',
    folder: 'personal',
    tags: ['recipes'],
  },
];

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  search: HybridSearch;
  noteIdByTitle: Map<string, string>;
}

function setup(provider: EmbeddingProvider = new NoopEmbeddings()): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const search = new HybridSearch(handle.db, fts, vec, provider);

  const folderIdByName = new Map<string, string>();
  const noteIdByTitle = new Map<string, string>();

  for (const item of FIXTURE) {
    let folderId: string | undefined;
    if (item.folder) {
      folderId = folderIdByName.get(item.folder);
      if (!folderId) {
        folderId = folders.create(item.folder).id;
        folderIdByName.set(item.folder, folderId);
      }
    }
    const created = notes.create(
      {
        body: item.body,
        folderId: folderId ?? null,
        tags: item.tags,
        source: 'user',
      },
      'user',
    );
    noteIdByTitle.set(item.title, created.id);
  }

  return { handle, notes, folders, search, noteIdByTitle };
}

describe('HybridSearch (FTS-only degradation path)', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('returns notes ordered by BM25 for a keyword query', async () => {
    const hits = await ctx.search.search('sqlite fts5', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.note.title).toBe('SQLite FTS5 basics');
    // All returned notes should mention at least one of the query terms.
    for (const h of hits) {
      const haystack = `${h.note.title} ${h.note.body}`.toLowerCase();
      expect(haystack.includes('sqlite') || haystack.includes('fts5')).toBe(true);
    }
  });

  it('matches semantically adjacent phrasing through the porter stemmer', async () => {
    const hits = await ctx.search.search('searching', { limit: 3 });
    const titles = hits.map((h) => h.note.title);
    expect(titles).toContain('Porter tokenizer notes');
  });

  it('returns highlighted snippets with <mark> tags', async () => {
    const [top] = await ctx.search.search('reciprocal rank fusion', { limit: 1 });
    expect(top).toBeDefined();
    expect(top!.snippet).not.toBeNull();
    expect(top!.snippet!).toMatch(/<mark>/);
  });

  it('returns no results for a query with no matches', async () => {
    const hits = await ctx.search.search('quantum teleportation helium', { limit: 5 });
    expect(hits).toEqual([]);
  });

  it('returns no results for an empty query', async () => {
    const hits = await ctx.search.search('', { limit: 5 });
    expect(hits).toEqual([]);
  });

  it('is resilient to FTS5 syntax characters in the query', async () => {
    const hits = await ctx.search.search('"NEAR(search,', { limit: 3 });
    // sanitizeFtsQuery strips operators; "search" remains as a prefix match.
    expect(hits.length).toBeGreaterThan(0);
  });

  it('filters by folder', async () => {
    const tech = ctx.handle.db
      .prepare('SELECT id FROM folders WHERE name = ?')
      .get('tech') as { id: string };
    const hits = await ctx.search.search('search', { limit: 10, folderId: tech.id });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.note.folderId).toBe(tech.id);
    }
  });

  it('filters by tag', async () => {
    const hits = await ctx.search.search('search', { limit: 10, tag: 'embeddings' });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.note.tags).toContain('embeddings');
    }
  });

  it('excludes soft-deleted notes', async () => {
    const deletedId = ctx.noteIdByTitle.get('SQLite FTS5 basics')!;
    ctx.notes.delete(deletedId, 'user');
    const hits = await ctx.search.search('sqlite fts5', { limit: 5 });
    const ids = hits.map((h) => h.note.id);
    expect(ids).not.toContain(deletedId);
  });

  /**
   * Audit N18 invariant — soft-deleted notes are filtered at every
   * layer that can return ids: FtsIndex, VecIndex, hybrid
   * applyFilters, hybrid fetchNotes. This test exercises the
   * applyFilters layer specifically by combining delete() + a folder
   * filter, so even if FTS/vec let the id slip through in a
   * future refactor, the post-filter would still catch it.
   */
  it('soft-deleted notes stay excluded under folder filter (defence-in-depth)', async () => {
    const deletedId = ctx.noteIdByTitle.get('SQLite FTS5 basics')!;
    const note = ctx.notes.getById(deletedId)!;
    ctx.notes.delete(deletedId, 'user');
    const hits = await ctx.search.search('sqlite fts5', {
      limit: 5,
      folderId: note.folderId,
    });
    expect(hits.map((h) => h.note.id)).not.toContain(deletedId);
  });

  it('picks up edits via the update trigger', async () => {
    const id = ctx.noteIdByTitle.get('Grocery list')!;
    ctx.notes.update(id, { body: '# Grocery list\n\nBuy mangoes and kimchi for the weekend.' }, 'user');
    const hits = await ctx.search.search('kimchi', { limit: 5 });
    expect(hits[0]?.note.id).toBe(id);
    const stale = await ctx.search.search('sourdough', { limit: 5 });
    expect(stale.map((h) => h.note.id)).not.toContain(id);
  });

  it('respects the limit parameter', async () => {
    const hits = await ctx.search.search('the', { limit: 3 });
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  // Archive filter: by default excluded; opt-in includes. The default
  // case also exercises the bug fix where unscoped searches (no folderId,
  // no tag) used to skip applyFilters entirely and leak archived notes.
  it('excludes archived notes by default on unscoped search', async () => {
    const archivedId = ctx.noteIdByTitle.get('SQLite FTS5 basics')!;
    ctx.notes.archive(archivedId, 'user');
    const hits = await ctx.search.search('sqlite fts5', { limit: 5 });
    expect(hits.map((h) => h.note.id)).not.toContain(archivedId);
  });

  it('includes archived notes when includeArchived is true', async () => {
    const archivedId = ctx.noteIdByTitle.get('SQLite FTS5 basics')!;
    ctx.notes.archive(archivedId, 'user');
    const hits = await ctx.search.search('sqlite fts5', {
      limit: 5,
      includeArchived: true,
    });
    expect(hits.map((h) => h.note.id)).toContain(archivedId);
  });

  it('archive filter still applies under folder filter', async () => {
    const archivedId = ctx.noteIdByTitle.get('SQLite FTS5 basics')!;
    const note = ctx.notes.getById(archivedId)!;
    ctx.notes.archive(archivedId, 'user');
    const hits = await ctx.search.search('sqlite', {
      limit: 5,
      folderId: note.folderId,
    });
    expect(hits.map((h) => h.note.id)).not.toContain(archivedId);
  });

  it('filters by createdAfter (inclusive lower bound)', async () => {
    const before = Date.now();
    // Sleep one ms so the new note's created_at is strictly after `before`.
    await new Promise((r) => setTimeout(r, 2));
    const created = ctx.notes.create(
      { body: '# fresh-marker\n\nbrand new note about sqlite', source: 'user' },
      'user',
    );
    const hits = await ctx.search.search('sqlite', {
      limit: 20,
      createdAfter: before,
    });
    const ids = hits.map((h) => h.note.id);
    expect(ids).toContain(created.id);
    // None of the older fixture notes should pass — they were inserted
    // before `before` was captured.
    for (const fixtureId of ctx.noteIdByTitle.values()) {
      expect(ids).not.toContain(fixtureId);
    }
  });

  it('filters by createdBefore (inclusive upper bound)', async () => {
    const cutoff = Date.now();
    await new Promise((r) => setTimeout(r, 2));
    const fresh = ctx.notes.create(
      { body: '# late-arrival\n\nlate note about sqlite', source: 'user' },
      'user',
    );
    const hits = await ctx.search.search('sqlite', {
      limit: 20,
      createdBefore: cutoff,
    });
    expect(hits.map((h) => h.note.id)).not.toContain(fresh.id);
    // Fixture notes about sqlite should still pass.
    expect(hits.length).toBeGreaterThan(0);
  });

  it('filters by updatedAfter on edits', async () => {
    const id = ctx.noteIdByTitle.get('Grocery list')!;
    const before = Date.now();
    await new Promise((r) => setTimeout(r, 2));
    ctx.notes.update(id, { body: '# Grocery list\n\nUpdated body about kimchi.' }, 'user');
    const hits = await ctx.search.search('kimchi', {
      limit: 5,
      updatedAfter: before,
    });
    expect(hits.map((h) => h.note.id)).toContain(id);
  });

  it('combines folder + tag + includeArchived + date range', async () => {
    const archivedId = ctx.noteIdByTitle.get('SQLite FTS5 basics')!;
    const note = ctx.notes.getById(archivedId)!;
    ctx.notes.archive(archivedId, 'user');
    const hits = await ctx.search.search('sqlite', {
      limit: 10,
      folderId: note.folderId,
      tag: 'sqlite',
      includeArchived: true,
      createdAfter: 0,
      updatedBefore: Date.now() + 1000,
    });
    const ids = hits.map((h) => h.note.id);
    expect(ids).toContain(archivedId);
    // All hits must satisfy each filter.
    for (const h of hits) {
      expect(h.note.folderId).toBe(note.folderId);
      expect(h.note.tags).toContain('sqlite');
    }
  });
});

describe('VecIndex.upsert', () => {
  it('re-embedding the same note id does not raise UNIQUE constraint', () => {
    // sqlite-vec's vec0 virtual table rejects INSERT OR REPLACE, so upsert
    // must delete-then-insert. Regression: without the fix, PATCH on any
    // already-indexed note 500s with "UNIQUE constraint failed on notes_vec
    // primary key".
    const handle = openDb({ path: ':memory:' });
    if (!handle.hasVec) {
      // Skip if sqlite-vec couldn't load in this environment.
      return;
    }
    const audit = new AuditLogger(handle.db);
    const notes = new NotesRepository(handle.db, audit);
    notes.create({ body: '# note-1', source: 'user' }, 'user');
    const note = notes.list({ limit: 1, offset: 0 })[0]!;
    const vec = new VecIndex(handle.db, true);
    const first = new Float32Array(384).fill(0.1);
    const second = new Float32Array(384).fill(0.2);
    expect(() => vec.upsert(note.id, first)).not.toThrow();
    expect(() => vec.upsert(note.id, second)).not.toThrow();
    expect(() => vec.upsert(note.id, second)).not.toThrow();
  });

  /**
   * Audit N19, 2026-04-16. `Indexer.reindex` is fire-and-forget and
   * embedding inference takes ~100 ms; a note can be soft-deleted
   * (or hard-purged) between the async embed() and this upsert. The
   * guard added in vec.ts refuses to write an embedding for a note
   * that no longer exists / is trashed, preventing a stale row in
   * notes_vec that would survive a restart.
   */
  it('refuses to upsert an embedding for a non-existent note id (N19)', () => {
    const handle = openDb({ path: ':memory:' });
    if (!handle.hasVec) return;
    const vec = new VecIndex(handle.db, true);
    const emb = new Float32Array(384).fill(0.5);
    // No row in `notes` with this id — upsert should silently no-op.
    expect(() => vec.upsert('01NONEXISTENTIDID00000000000', emb)).not.toThrow();
    const row = handle.db
      .prepare<[string], { note_id: string }>(
        'SELECT note_id FROM notes_vec WHERE note_id = ?',
      )
      .get('01NONEXISTENTIDID00000000000');
    expect(row).toBeUndefined();
  });

  it('refuses to upsert an embedding for a soft-deleted note (N19)', () => {
    const handle = openDb({ path: ':memory:' });
    if (!handle.hasVec) return;
    const audit = new AuditLogger(handle.db);
    const notes = new NotesRepository(handle.db, audit);
    const live = notes.create({ body: '# live', source: 'user' }, 'user');
    const vec = new VecIndex(handle.db, true);
    const emb = new Float32Array(384).fill(0.7);
    // First upsert succeeds while the note is live.
    vec.upsert(live.id, emb);
    expect(
      handle.db
        .prepare<[string], { note_id: string }>(
          'SELECT note_id FROM notes_vec WHERE note_id = ?',
        )
        .get(live.id),
    ).toBeDefined();
    // Soft-delete and re-upsert — the guard should refuse. The old row
    // from the live upsert is fine to leave (HybridSearch.vec.search
    // JOINs notes and filters by deleted_at IS NULL, so it's already
    // invisible); what N19 prevents is a NEW write against a deleted id.
    notes.delete(live.id, 'user');
    // Simulate a late-arriving reindex after the note was deleted.
    // The guard MUST refuse — otherwise we'd re-insert a row that would
    // outlive the note's SQL presence.
    const prev = handle.db
      .prepare<[string], { note_id: string }>(
        'SELECT note_id FROM notes_vec WHERE note_id = ?',
      )
      .get(live.id);
    // Wipe the vec row so we can see whether upsert would put it back.
    handle.db.prepare('DELETE FROM notes_vec WHERE note_id = ?').run(live.id);
    vec.upsert(live.id, emb);
    const after = handle.db
      .prepare<[string], { note_id: string }>(
        'SELECT note_id FROM notes_vec WHERE note_id = ?',
      )
      .get(live.id);
    expect(prev).toBeDefined(); // sanity — the live upsert worked
    expect(after).toBeUndefined(); // guard refused to re-insert
  });
});

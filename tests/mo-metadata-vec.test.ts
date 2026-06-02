import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import {
  ConciergeFolderSettingsRepository,
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  MoMetadataVecRepository,
  buildMoMetadataEmbedText,
  listMoMetadataVecBackfillCandidates,
} from '../src/core/concierge/index.js';
import { runTier1ForNote } from '../src/core/concierge/mo-tier1.js';
import type {
  EmbeddingProvider,
} from '../src/core/embeddings/provider.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../src/core/concierge/provider.js';

interface Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  folderSettings: ConciergeFolderSettingsRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  vec: MoMetadataVecRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const meta = new NoteMoMetadataRepository(handle.db);
  const clusters = new NoteMoClustersRepository(handle.db);
  const vec = new MoMetadataVecRepository(handle.db, handle.hasVec);
  return { handle, audit, notes, folders, folderSettings, meta, clusters, vec };
}

/**
 * Deterministic stub embedder: hashes the input text into a single
 * "bucket" of a one-hot 384-dim vector. Same text → same vector
 * (round-trip = distance 0); different texts → orthogonal-or-distant.
 * Lets us test the plumbing (write/read/filter) without depending on
 * real embedding semantics or model loading.
 */
class StubEmbeddings implements EmbeddingProvider {
  readonly dim = 384;
  constructor(private readonly returnsNull = false) {}
  async embed(text: string): Promise<Float32Array | null> {
    if (this.returnsNull) return null;
    const vec = new Float32Array(this.dim);
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    }
    vec[hash % this.dim] = 1.0;
    return vec;
  }
  async available(): Promise<boolean> {
    return !this.returnsNull;
  }
}

class StubLLM implements LLMProvider {
  readonly name = 'stub';
  constructor(private readonly responseJson: object) {}
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    return {
      content: JSON.stringify(this.responseJson),
      toolCalls: [],
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.0001,
      model: 'stub',
    };
  }
}

describe('buildMoMetadataEmbedText', () => {
  it('returns null when both summary + keywords are empty', () => {
    expect(buildMoMetadataEmbedText('', [])).toBeNull();
    expect(buildMoMetadataEmbedText('   ', ['  '])).toBeNull();
  });

  it('returns trimmed summary alone when keywords empty', () => {
    expect(buildMoMetadataEmbedText('  hello world  ', [])).toBe('hello world');
  });

  it('returns joined keywords alone when summary empty', () => {
    expect(buildMoMetadataEmbedText('', ['stripe', 'webhook', 'idempotency'])).toBe(
      'stripe webhook idempotency',
    );
  });

  it('joins summary + keywords with single space', () => {
    expect(
      buildMoMetadataEmbedText('Note about Stripe.', ['stripe', 'webhook']),
    ).toBe('Note about Stripe. stripe webhook');
  });
});

describe('MoMetadataVecRepository — round-trip', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('upsert + has + searchSimilar round-trip when sqlite-vec available', async () => {
    if (!ctx.handle.hasVec) {
      // CI without sqlite-vec — skip semantic part; the no-op tests
      // below still exercise the disabled path.
      return;
    }
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create(
      { body: '# Stripe webhooks', folderId: folder.id, source: 'user' },
      'user',
    );
    const b = ctx.notes.create(
      { body: '# Tetris game', folderId: folder.id, source: 'user' },
      'user',
    );

    const embedder = new StubEmbeddings();
    const vecA = await embedder.embed('alpha summary');
    const vecB = await embedder.embed('bravo summary');
    expect(vecA).not.toBeNull();
    expect(vecB).not.toBeNull();

    ctx.vec.upsert(a.id, vecA!);
    ctx.vec.upsert(b.id, vecB!);

    expect(ctx.vec.has(a.id)).toBe(true);
    expect(ctx.vec.has(b.id)).toBe(true);

    // Querying with vecA should bring noteA closest (distance 0).
    const hits = ctx.vec.searchSimilar(vecA!, { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.noteId).toBe(a.id);
    expect(hits[0]?.distance).toBeLessThan(0.001);
  });

  it('searchSimilar respects folderId scope', async () => {
    if (!ctx.handle.hasVec) return;
    const fA = ctx.folders.create('A');
    const fB = ctx.folders.create('B');
    const inA = ctx.notes.create(
      { body: '# A note', folderId: fA.id, source: 'user' },
      'user',
    );
    const inB = ctx.notes.create(
      { body: '# B note', folderId: fB.id, source: 'user' },
      'user',
    );

    const embedder = new StubEmbeddings();
    const vec1 = await embedder.embed('shared text');
    const vec2 = await embedder.embed('shared text');
    ctx.vec.upsert(inA.id, vec1!);
    ctx.vec.upsert(inB.id, vec2!);

    const scopedToA = ctx.vec.searchSimilar(vec1!, { limit: 10, folderId: fA.id });
    expect(scopedToA.map((h) => h.noteId)).toEqual([inA.id]);

    const scopedToB = ctx.vec.searchSimilar(vec1!, { limit: 10, folderId: fB.id });
    expect(scopedToB.map((h) => h.noteId)).toEqual([inB.id]);
  });

  it('searchSimilar respects excludeNoteIds', async () => {
    if (!ctx.handle.hasVec) return;
    const folder = ctx.folders.create('F');
    const a = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    const b = ctx.notes.create({ body: '# B', folderId: folder.id, source: 'user' }, 'user');
    const c = ctx.notes.create({ body: '# C', folderId: folder.id, source: 'user' }, 'user');

    const embedder = new StubEmbeddings();
    const vA = await embedder.embed('text-a');
    const vB = await embedder.embed('text-b');
    const vC = await embedder.embed('text-c');
    ctx.vec.upsert(a.id, vA!);
    ctx.vec.upsert(b.id, vB!);
    ctx.vec.upsert(c.id, vC!);

    const hits = ctx.vec.searchSimilar(vA!, {
      limit: 10,
      excludeNoteIds: [a.id, c.id],
    });
    expect(hits.map((h) => h.noteId)).not.toContain(a.id);
    expect(hits.map((h) => h.noteId)).not.toContain(c.id);
    expect(hits.map((h) => h.noteId)).toContain(b.id);
  });

  it('upsert short-circuits when underlying note is soft-deleted', async () => {
    if (!ctx.handle.hasVec) return;
    const folder = ctx.folders.create('F');
    const n = ctx.notes.create({ body: '# X', folderId: folder.id, source: 'user' }, 'user');
    ctx.notes.delete(n.id, 'user');

    const embedder = new StubEmbeddings();
    const v = await embedder.embed('whatever');
    ctx.vec.upsert(n.id, v!);

    expect(ctx.vec.has(n.id)).toBe(false);
  });

  it('delete removes the embedding row', async () => {
    if (!ctx.handle.hasVec) return;
    const folder = ctx.folders.create('F');
    const n = ctx.notes.create({ body: '# X', folderId: folder.id, source: 'user' }, 'user');
    const embedder = new StubEmbeddings();
    const v = await embedder.embed('xyz');
    ctx.vec.upsert(n.id, v!);
    expect(ctx.vec.has(n.id)).toBe(true);
    ctx.vec.delete(n.id);
    expect(ctx.vec.has(n.id)).toBe(false);
  });
});

describe('MoMetadataVecRepository — graceful degrade when vec unavailable', () => {
  it('upsert / search / has / delete all no-op when enabled=false', async () => {
    // Build a repo with `enabled=false` regardless of whether the host
    // actually loaded sqlite-vec.
    const ctx = setup();
    const disabled = new MoMetadataVecRepository(ctx.handle.db, false);
    const dummyVec = new Float32Array(384);
    dummyVec[0] = 1.0;

    expect(() => disabled.upsert('01HYNOTREALNOTEID01', dummyVec)).not.toThrow();
    expect(disabled.has('01HYNOTREALNOTEID01')).toBe(false);
    expect(disabled.searchSimilar(dummyVec, { limit: 10 })).toEqual([]);
    expect(() => disabled.delete('01HYNOTREALNOTEID01')).not.toThrow();
  });
});

describe('listMoMetadataVecBackfillCandidates', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns notes with metadata but no vec entry', () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });

    const a = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    const b = ctx.notes.create({ body: '# B', folderId: folder.id, source: 'user' }, 'user');
    const c = ctx.notes.create({ body: '# C', folderId: folder.id, source: 'user' }, 'user');

    ctx.meta.upsert({
      noteId: a.id,
      summary: 'A summary',
      keywords: ['a'],
      computedBy: 'tier1',
    });
    ctx.meta.upsert({
      noteId: b.id,
      summary: 'B summary',
      keywords: ['b'],
      computedBy: 'tier1',
    });
    // c has no metadata at all → not eligible (Tier 1 will write one)

    const candidates = listMoMetadataVecBackfillCandidates(ctx.handle.db, 50);
    const ids = candidates.map((c) => c.noteId).sort();
    expect(ids).toEqual([a.id, b.id].sort());

    const aRow = candidates.find((c) => c.noteId === a.id);
    expect(aRow?.summary).toBe('A summary');
    expect(aRow?.keywords).toEqual(['a']);
  });

  it('excludes mo:* system notes', () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const sys = ctx.notes.create(
      { body: '# mo:catalog', folderId: folder.id, source: 'mo:catalog' },
      'morion-concierge',
    );
    ctx.meta.upsert({
      noteId: sys.id,
      summary: 'should NOT appear',
      keywords: [],
      computedBy: 'tier1',
    });
    const candidates = listMoMetadataVecBackfillCandidates(ctx.handle.db, 50);
    expect(candidates.map((c) => c.noteId)).not.toContain(sys.id);
  });

  it('excludes notes in folders with Mo disabled', () => {
    const enabled = ctx.folders.create('Enabled');
    const disabled = ctx.folders.create('Disabled');
    ctx.folderSettings.update(enabled.id, { enabled: true });
    // disabled folder gets default settings (enabled=false)

    const goodNote = ctx.notes.create(
      { body: '# good', folderId: enabled.id, source: 'user' },
      'user',
    );
    const badNote = ctx.notes.create(
      { body: '# bad', folderId: disabled.id, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: goodNote.id,
      summary: 'g',
      keywords: [],
      computedBy: 'tier1',
    });
    ctx.meta.upsert({
      noteId: badNote.id,
      summary: 'b',
      keywords: [],
      computedBy: 'tier1',
    });

    const candidates = listMoMetadataVecBackfillCandidates(ctx.handle.db, 50);
    const ids = candidates.map((c) => c.noteId);
    expect(ids).toContain(goodNote.id);
    expect(ids).not.toContain(badNote.id);
  });

  it('excludes soft-deleted and archived notes', () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const live = ctx.notes.create({ body: '# L', folderId: folder.id, source: 'user' }, 'user');
    const deleted = ctx.notes.create({ body: '# D', folderId: folder.id, source: 'user' }, 'user');
    const archived = ctx.notes.create({ body: '# A', folderId: folder.id, source: 'user' }, 'user');
    ctx.meta.upsert({ noteId: live.id, summary: 'l', keywords: [], computedBy: 'tier1' });
    ctx.meta.upsert({ noteId: deleted.id, summary: 'd', keywords: [], computedBy: 'tier1' });
    ctx.meta.upsert({ noteId: archived.id, summary: 'a', keywords: [], computedBy: 'tier1' });
    ctx.notes.delete(deleted.id, 'user');
    ctx.notes.archive(archived.id, 'user');

    const candidates = listMoMetadataVecBackfillCandidates(ctx.handle.db, 50);
    const ids = candidates.map((c) => c.noteId);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(deleted.id);
    expect(ids).not.toContain(archived.id);
  });
});

describe('Tier 1 hook — writes vec after metadata', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('writes embedding to mo_metadata_vec after metadata upsert', async () => {
    if (!ctx.handle.hasVec) return;
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      {
        body: '# Stripe webhook idempotency\n\nWe deduplicate via event_id.',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );

    const llm = new StubLLM({
      summary: 'How we deduplicate Stripe webhooks via event_id.',
      keywords: ['stripe', 'webhook', 'idempotency'],
      cluster_candidates: [{ cluster_id: 'stripe', confidence: 0.9 }],
    });
    const embedder = new StubEmbeddings();

    const result = await runTier1ForNote(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: llm,
        model: 'stub',
        vec: ctx.vec,
        embeddings: embedder,
      },
      note.id,
      {},
    );

    expect(result.status).toBe('computed');
    expect(ctx.meta.get(note.id)?.summary).toContain('deduplicate');
    expect(ctx.vec.has(note.id)).toBe(true);
  });

  it('skips vec write when embedder returns null (provider unavailable)', async () => {
    if (!ctx.handle.hasVec) return;
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      {
        body: '# X note title\n\nSome body text long enough to clear the Tier 1 minimum-body gate.',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    const llm = new StubLLM({
      summary: 'X summary',
      keywords: ['x'],
      cluster_candidates: [{ cluster_id: 'x', confidence: 0.9 }],
    });
    const nullEmbedder = new StubEmbeddings(true);

    const result = await runTier1ForNote(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: llm,
        model: 'stub',
        vec: ctx.vec,
        embeddings: nullEmbedder,
      },
      note.id,
      {},
    );

    expect(result.status).toBe('computed');
    expect(ctx.meta.get(note.id)?.summary).toBe('X summary');
    expect(ctx.vec.has(note.id)).toBe(false);
  });

  it('skips vec write when deps.vec / deps.embeddings absent', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      {
        body: '# Y note title\n\nSome body text long enough to clear the Tier 1 minimum-body gate.',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    const llm = new StubLLM({
      summary: 'Y summary',
      keywords: ['y'],
      cluster_candidates: [{ cluster_id: 'y', confidence: 0.9 }],
    });

    const result = await runTier1ForNote(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: llm,
        model: 'stub',
        // vec + embeddings deliberately omitted
      },
      note.id,
      {},
    );

    expect(result.status).toBe('computed');
    expect(ctx.meta.get(note.id)?.summary).toBe('Y summary');
    expect(ctx.vec.has(note.id)).toBe(false);
  });
});

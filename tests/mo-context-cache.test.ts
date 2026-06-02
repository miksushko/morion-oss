import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import {
  MoContextCacheRepository,
  buildExactCacheKey,
  cosineSimilarity,
  SEMANTIC_MATCH_THRESHOLD,
  EXACT_MATCH_TTL_MS,
  SEMANTIC_WINDOW_MS,
} from '../src/core/concierge/index.js';

interface Ctx {
  handle: DbHandle;
  cache: MoContextCacheRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const cache = new MoContextCacheRepository(handle.db);
  return { handle, cache };
}

function makeVec(seed: number, dim = 384): Float32Array {
  const v = new Float32Array(dim);
  // Stable pseudo-random fill keyed by seed; keeps each vector
  // distinct without needing a real embedder.
  let x = seed * 2654435761;
  for (let i = 0; i < dim; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    v[i] = (x / 0xffffffff) * 2 - 1;
  }
  return v;
}

function nudgeVec(base: Float32Array, jitter: number, seed: number): Float32Array {
  const v = new Float32Array(base.length);
  const noise = makeVec(seed, base.length);
  for (let i = 0; i < base.length; i++) {
    v[i] = base[i]! + jitter * noise[i]!;
  }
  return v;
}

describe('buildExactCacheKey', () => {
  it('returns a stable hex hash given identical inputs', () => {
    const k1 = buildExactCacheKey({
      taskId: '01HABC',
      taskBodyHash: 'hash-a',
      folderCatalogHash: 'hash-b',
      mode: 'full',
      scope: 'folder',
    });
    const k2 = buildExactCacheKey({
      taskId: '01HABC',
      taskBodyHash: 'hash-a',
      folderCatalogHash: 'hash-b',
      mode: 'full',
      scope: 'folder',
    });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any meaningful input differs', () => {
    const base = {
      taskId: '01HABC',
      taskBodyHash: 'hash-a',
      folderCatalogHash: 'hash-b',
      mode: 'full',
      scope: 'folder',
    } as const;
    const baseKey = buildExactCacheKey(base);
    expect(buildExactCacheKey({ ...base, taskBodyHash: 'hash-A' })).not.toBe(baseKey);
    expect(buildExactCacheKey({ ...base, mode: 'thorough' })).not.toBe(baseKey);
    expect(buildExactCacheKey({ ...base, scope: 'workspace' })).not.toBe(baseKey);
    expect(buildExactCacheKey({ ...base, folderCatalogHash: 'hash-C' })).not.toBe(baseKey);
    expect(buildExactCacheKey({ ...base, taskId: '01HOTHER' })).not.toBe(baseKey);
  });

  it('treats null / undefined / empty consistently for optional fields', () => {
    const a = buildExactCacheKey({ mode: 'ask', scope: 'folder' });
    const b = buildExactCacheKey({
      taskId: null,
      taskBodyHash: null,
      folderCatalogHash: null,
      extra: null,
      mode: 'ask',
      scope: 'folder',
    });
    expect(a).toBe(b);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = makeVec(42);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 6);
  });

  it('returns ~0 for orthogonal vectors', () => {
    const a = new Float32Array(4);
    const b = new Float32Array(4);
    a[0] = 1;
    b[1] = 1;
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it('returns -1 for antiparallel vectors', () => {
    const a = new Float32Array(4);
    const b = new Float32Array(4);
    a[0] = 1;
    b[0] = -1;
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it('returns NaN when either vector is the zero vector', () => {
    const a = new Float32Array(4);
    const b = new Float32Array(4);
    b[0] = 1;
    expect(Number.isNaN(cosineSimilarity(a, b))).toBe(true);
  });

  it('throws on dimension mismatch', () => {
    expect(() =>
      cosineSimilarity(new Float32Array(3), new Float32Array(4)),
    ).toThrow(/dim mismatch/);
  });
});

describe('MoContextCacheRepository — insert + peek', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('round-trips a row including question_embedding', () => {
    const vec = makeVec(7);
    ctx.cache.insert(
      {
        cacheKey: 'k1',
        packetJson: JSON.stringify({ hello: 'world' }),
        questionEmbedding: vec,
        mode: 'full',
        scope: 'folder',
      },
      1000,
    );

    const peeked = ctx.cache.peek('k1');
    expect(peeked).not.toBeNull();
    expect(peeked!.cacheKey).toBe('k1');
    expect(peeked!.mode).toBe('full');
    expect(peeked!.scope).toBe('folder');
    expect(peeked!.hitCount).toBe(0);
    expect(peeked!.questionEmbedding).not.toBeNull();
    expect(peeked!.questionEmbedding!.length).toBe(384);
    // First 5 values match (round-trip preserves bytes).
    for (let i = 0; i < 5; i++) {
      expect(peeked!.questionEmbedding![i]).toBeCloseTo(vec[i]!, 5);
    }
  });

  it('insert with same key replaces row + resets hit_count', () => {
    ctx.cache.insert(
      {
        cacheKey: 'k1',
        packetJson: '{"v":1}',
        mode: 'full',
        scope: 'folder',
      },
      1000,
    );
    // Bump hit_count via a lookupExact, then re-insert.
    ctx.cache.lookupExact('k1', 1500, 60_000);
    expect(ctx.cache.peek('k1')!.hitCount).toBe(1);

    ctx.cache.insert(
      {
        cacheKey: 'k1',
        packetJson: '{"v":2}',
        mode: 'full',
        scope: 'folder',
      },
      2000,
    );
    const reread = ctx.cache.peek('k1');
    expect(reread!.packetJson).toBe('{"v":2}');
    expect(reread!.hitCount).toBe(0);
    expect(reread!.createdAt).toBe(2000);
  });

  it('insert without questionEmbedding stores null', () => {
    ctx.cache.insert(
      {
        cacheKey: 'k1',
        packetJson: '{}',
        mode: 'full',
        scope: 'folder',
      },
      1000,
    );
    expect(ctx.cache.peek('k1')!.questionEmbedding).toBeNull();
  });
});

describe('MoContextCacheRepository — lookupExact', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns null on cache miss', () => {
    expect(ctx.cache.lookupExact('nope')).toBeNull();
  });

  it('returns the row when key matches and within TTL', () => {
    ctx.cache.insert(
      {
        cacheKey: 'k1',
        packetJson: '{"v":1}',
        mode: 'full',
        scope: 'folder',
      },
      1000,
    );
    const hit = ctx.cache.lookupExact('k1', 1500, 60_000);
    expect(hit).not.toBeNull();
    expect(hit!.packetJson).toBe('{"v":1}');
    expect(hit!.hitCount).toBe(1);
  });

  it('bumps hit_count on every lookup', () => {
    ctx.cache.insert(
      { cacheKey: 'k1', packetJson: '{}', mode: 'full', scope: 'folder' },
      1000,
    );
    ctx.cache.lookupExact('k1', 1500, 60_000);
    ctx.cache.lookupExact('k1', 1600, 60_000);
    ctx.cache.lookupExact('k1', 1700, 60_000);
    expect(ctx.cache.peek('k1')!.hitCount).toBe(3);
  });

  it('treats rows older than TTL as misses', () => {
    ctx.cache.insert(
      { cacheKey: 'k1', packetJson: '{}', mode: 'full', scope: 'folder' },
      1000,
    );
    // 2h later with 1h TTL.
    expect(ctx.cache.lookupExact('k1', 1000 + 2 * 60 * 60 * 1000, EXACT_MATCH_TTL_MS)).toBeNull();
  });
});

describe('MoContextCacheRepository — lookupSemantic', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns null when no rows in window match (mode/scope/threshold)', () => {
    const v = makeVec(7);
    expect(
      ctx.cache.lookupSemantic(v, { mode: 'full', scope: 'folder' }),
    ).toBeNull();
  });

  it('returns the same row when query is identical to stored embedding', () => {
    const v = makeVec(7);
    ctx.cache.insert(
      {
        cacheKey: 'k1',
        packetJson: '{"v":1}',
        questionEmbedding: v,
        mode: 'full',
        scope: 'folder',
      },
      1000,
    );
    const result = ctx.cache.lookupSemantic(v, {
      mode: 'full',
      scope: 'folder',
      now: 1500,
    });
    expect(result).not.toBeNull();
    expect(result!.row.cacheKey).toBe('k1');
    expect(result!.similarity).toBeCloseTo(1.0, 5);
  });

  it('returns nearby vectors above threshold', () => {
    const base = makeVec(7);
    ctx.cache.insert(
      {
        cacheKey: 'k1',
        packetJson: '{"v":1}',
        questionEmbedding: base,
        mode: 'full',
        scope: 'folder',
      },
      1000,
    );
    // Tiny jitter — should still be > 0.92.
    const nearby = nudgeVec(base, 0.01, 99);
    const hit = ctx.cache.lookupSemantic(nearby, {
      mode: 'full',
      scope: 'folder',
      now: 1500,
    });
    expect(hit).not.toBeNull();
    expect(hit!.similarity).toBeGreaterThan(SEMANTIC_MATCH_THRESHOLD);
  });

  it('returns null when nearest is below threshold', () => {
    const a = makeVec(7);
    const b = makeVec(99);
    ctx.cache.insert(
      {
        cacheKey: 'k1',
        packetJson: '{"v":1}',
        questionEmbedding: a,
        mode: 'full',
        scope: 'folder',
      },
      1000,
    );
    // Mostly random orthogonal-ish vector — cosine should be near 0.
    const hit = ctx.cache.lookupSemantic(b, {
      mode: 'full',
      scope: 'folder',
      now: 1500,
    });
    expect(hit).toBeNull();
  });

  it('respects mode + scope partition (different modes never match)', () => {
    const v = makeVec(7);
    ctx.cache.insert(
      {
        cacheKey: 'k1',
        packetJson: '{}',
        questionEmbedding: v,
        mode: 'full',
        scope: 'folder',
      },
      1000,
    );
    expect(
      ctx.cache.lookupSemantic(v, { mode: 'thorough', scope: 'folder', now: 1500 }),
    ).toBeNull();
    expect(
      ctx.cache.lookupSemantic(v, { mode: 'full', scope: 'workspace', now: 1500 }),
    ).toBeNull();
  });

  it('skips rows older than the semantic window', () => {
    const v = makeVec(7);
    ctx.cache.insert(
      {
        cacheKey: 'k1',
        packetJson: '{}',
        questionEmbedding: v,
        mode: 'full',
        scope: 'folder',
      },
      1000,
    );
    // 25h later with default 24h window.
    const hit = ctx.cache.lookupSemantic(v, {
      mode: 'full',
      scope: 'folder',
      now: 1000 + 25 * 60 * 60 * 1000,
    });
    expect(hit).toBeNull();
  });

  it('picks the highest-similarity row when multiple are above threshold', () => {
    const target = makeVec(7);
    const farther = nudgeVec(target, 0.05, 11);
    const closer = nudgeVec(target, 0.001, 22);
    ctx.cache.insert(
      {
        cacheKey: 'k-far',
        packetJson: '{}',
        questionEmbedding: farther,
        mode: 'full',
        scope: 'folder',
      },
      1000,
    );
    ctx.cache.insert(
      {
        cacheKey: 'k-close',
        packetJson: '{}',
        questionEmbedding: closer,
        mode: 'full',
        scope: 'folder',
      },
      1000,
    );
    const hit = ctx.cache.lookupSemantic(target, {
      mode: 'full',
      scope: 'folder',
      now: 1500,
    });
    expect(hit?.row.cacheKey).toBe('k-close');
  });

  it('skips rows with null question_embedding', () => {
    const v = makeVec(7);
    ctx.cache.insert(
      {
        cacheKey: 'k1',
        packetJson: '{}',
        // no questionEmbedding
        mode: 'full',
        scope: 'folder',
      },
      1000,
    );
    expect(
      ctx.cache.lookupSemantic(v, { mode: 'full', scope: 'folder', now: 1500 }),
    ).toBeNull();
  });
});

describe('MoContextCacheRepository — TTL cleanup on insert', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('drops rows older than the semantic window when a new row inserts', () => {
    ctx.cache.insert(
      { cacheKey: 'old', packetJson: '{}', mode: 'full', scope: 'folder' },
      1000,
    );
    expect(ctx.cache.count()).toBe(1);
    // Insert "now" = 1000 + window + 1ms → old row should be pruned.
    const farFuture = 1000 + SEMANTIC_WINDOW_MS + 1;
    ctx.cache.insert(
      { cacheKey: 'new', packetJson: '{}', mode: 'full', scope: 'folder' },
      farFuture,
    );
    expect(ctx.cache.count()).toBe(1);
    expect(ctx.cache.peek('old')).toBeNull();
    expect(ctx.cache.peek('new')).not.toBeNull();
  });

  it('manual cleanupOlderThan returns the number of rows dropped', () => {
    ctx.cache.insert(
      { cacheKey: 'a', packetJson: '{}', mode: 'full', scope: 'folder' },
      1000,
    );
    ctx.cache.insert(
      { cacheKey: 'b', packetJson: '{}', mode: 'full', scope: 'folder' },
      2000,
    );
    ctx.cache.insert(
      { cacheKey: 'c', packetJson: '{}', mode: 'full', scope: 'folder' },
      3000,
    );
    expect(ctx.cache.cleanupOlderThan(2500)).toBe(2);
    expect(ctx.cache.count()).toBe(1);
    expect(ctx.cache.peek('c')).not.toBeNull();
  });
});

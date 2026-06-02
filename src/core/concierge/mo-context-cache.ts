import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Phase 5 of context restructure (ticket `01KQFQ1RJV7EH0X3WF2H1A476J`).
 *
 * Two-layer cache for `mo_get_context` / `mo_ask` synthesis packets:
 *
 *   1. **Exact match** — `cache_key = hash(taskId, body_hash,
 *      folder_catalog_hash, mode, scope)`. When the same task is
 *      re-asked AND nothing material has changed (body, folder
 *      catalog, mode, scope), return the cached packet. TTL 1h.
 *      Zero LLM cost.
 *
 *   2. **Semantic match** — when no exact key, embed the incoming
 *      question/task, brute-force cosine vs every cached
 *      `question_embedding` from the last 24h, return the best match
 *      if cosine ≥ 0.92 (default). One embedding call (~$0.0001)
 *      vs the full deep-research loop (~$0.02).
 *
 * Caller is responsible for:
 *   - Computing the exact-match key via {@link buildExactCacheKey}.
 *   - Embedding the incoming question (cosine threshold = repository's
 *     concern; the embedder is shared with `notes_vec` / `mo_metadata_vec`).
 *   - Running cleanup periodically (or letting the on-insert TTL
 *     prune handle it).
 *
 * The packet JSON shape is opaque to this layer — caller serialises
 * `WorkContextPacket` (or `mo_ask` cited answer) and rehydrates on read.
 */

export interface MoContextCacheRow {
  cacheKey: string;
  packetJson: string;
  questionEmbedding: Float32Array | null;
  mode: string;
  scope: string;
  createdAt: number;
  hitCount: number;
}

interface Row {
  cache_key: string;
  packet_json: string;
  question_embedding: Buffer | null;
  mode: string;
  scope: string;
  created_at: number;
  hit_count: number;
}

function rowToRecord(row: Row): MoContextCacheRow {
  let questionEmbedding: Float32Array | null = null;
  if (row.question_embedding && row.question_embedding.length > 0) {
    // Buffers from sqlite share the underlying allocation; copy into a
    // typed array so the caller can hold it past the next query.
    const bytes = new Uint8Array(
      row.question_embedding.buffer,
      row.question_embedding.byteOffset,
      row.question_embedding.byteLength,
    );
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    questionEmbedding = new Float32Array(copy.buffer);
  }
  return {
    cacheKey: row.cache_key,
    packetJson: row.packet_json,
    questionEmbedding,
    mode: row.mode,
    scope: row.scope,
    createdAt: row.created_at,
    hitCount: row.hit_count,
  };
}

export interface CacheInsertInput {
  cacheKey: string;
  packetJson: string;
  /** Optional — pass when the packet was synthesised from a question
   *  string (vs purely from a task id). Required for semantic match
   *  to work on subsequent calls. */
  questionEmbedding?: Float32Array | null;
  mode: string;
  scope: string;
}

/** Default cosine threshold for semantic match. 0.92 picks "the same
 *  question rephrased" without admitting "vaguely topic-adjacent"
 *  questions. Tunable per-call via `lookupSemantic`. */
export const SEMANTIC_MATCH_THRESHOLD = 0.92;

/** Default TTL for exact-match hits. 1 hour balances "user iterating
 *  on a task across a session" against "stale packet after meaningful
 *  edits". The exact-key already covers body_hash / catalog_hash drift,
 *  so this TTL is a backstop, not the primary freshness lever. */
export const EXACT_MATCH_TTL_MS = 60 * 60 * 1000; // 1h

/** Default semantic-match window. 24h matches the "user works on the
 *  same problem across a day" pattern. Older rows pruned on insert. */
export const SEMANTIC_WINDOW_MS = 24 * 60 * 60 * 1000;

export class MoContextCacheRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Exact-match lookup. Returns the row IFF cache_key matches AND the
   * row is younger than `ttlMs` (default 1h). Bumps `hit_count` on hit.
   * Single SQL round-trip via UPDATE...RETURNING-equivalent (better-sqlite3
   * uses a separate UPDATE after SELECT — atomic enough for cache state).
   */
  lookupExact(
    cacheKey: string,
    now: number = Date.now(),
    ttlMs: number = EXACT_MATCH_TTL_MS,
  ): MoContextCacheRow | null {
    const cutoff = now - ttlMs;
    const row = this.db
      .prepare<[string, number], Row>(
        `SELECT * FROM mo_context_cache
          WHERE cache_key = ? AND created_at >= ?`,
      )
      .get(cacheKey, cutoff);
    if (!row) return null;
    this.db
      .prepare('UPDATE mo_context_cache SET hit_count = hit_count + 1 WHERE cache_key = ?')
      .run(cacheKey);
    return { ...rowToRecord(row), hitCount: row.hit_count + 1 };
  }

  /**
   * Semantic-match lookup. Brute-force cosine over every row in the
   * last `windowMs` whose `(mode, scope)` matches. Returns the BEST
   * row if cosine ≥ `threshold`, plus the similarity score, else null.
   *
   * Brute-force is fine: the working set is bounded by the daily
   * cleanup (~hundreds of rows), and each cosine over 384 floats is
   * sub-microsecond. If the cache grows past ~10k live rows we'd
   * promote to a proper vec0 table — but pre-promote scoring is
   * cheaper than the indirection.
   *
   * Bumps `hit_count` on the matched row when found.
   */
  lookupSemantic(
    queryEmbedding: Float32Array,
    opts: {
      mode: string;
      scope: string;
      threshold?: number;
      now?: number;
      windowMs?: number;
    },
  ): { row: MoContextCacheRow; similarity: number } | null {
    const threshold = opts.threshold ?? SEMANTIC_MATCH_THRESHOLD;
    const now = opts.now ?? Date.now();
    const windowMs = opts.windowMs ?? SEMANTIC_WINDOW_MS;
    const cutoff = now - windowMs;

    const rows = this.db
      .prepare<[string, string, number], Row>(
        `SELECT * FROM mo_context_cache
          WHERE mode = ? AND scope = ? AND created_at >= ?
            AND question_embedding IS NOT NULL`,
      )
      .all(opts.mode, opts.scope, cutoff);

    let bestRow: Row | null = null;
    let bestSim = -Infinity;
    for (const r of rows) {
      const rec = rowToRecord(r);
      if (!rec.questionEmbedding) continue;
      const sim = cosineSimilarity(queryEmbedding, rec.questionEmbedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestRow = r;
      }
    }

    if (!bestRow || bestSim < threshold) return null;
    this.db
      .prepare('UPDATE mo_context_cache SET hit_count = hit_count + 1 WHERE cache_key = ?')
      .run(bestRow.cache_key);
    return {
      row: { ...rowToRecord(bestRow), hitCount: bestRow.hit_count + 1 },
      similarity: bestSim,
    };
  }

  /**
   * Insert (or replace) a cache row. Replaces on conflicting cache_key
   * — same key only differs by timestamp, so newest wins. Triggers TTL
   * cleanup of rows older than {@link SEMANTIC_WINDOW_MS} so the
   * working set stays bounded without a separate cron.
   */
  insert(input: CacheInsertInput, now: number = Date.now()): void {
    const buf = input.questionEmbedding
      ? Buffer.from(
          input.questionEmbedding.buffer,
          input.questionEmbedding.byteOffset,
          input.questionEmbedding.byteLength,
        )
      : null;
    this.db
      .prepare(
        `INSERT INTO mo_context_cache
           (cache_key, packet_json, question_embedding, mode, scope, created_at, hit_count)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(cache_key) DO UPDATE SET
           packet_json = excluded.packet_json,
           question_embedding = excluded.question_embedding,
           mode = excluded.mode,
           scope = excluded.scope,
           created_at = excluded.created_at,
           hit_count = 0`,
      )
      .run(input.cacheKey, input.packetJson, buf, input.mode, input.scope, now);

    this.cleanupOlderThan(now - SEMANTIC_WINDOW_MS);
  }

  /**
   * Drop every row older than `cutoffMs`. Called automatically on
   * insert; exposed publicly so tests can pin the boundary and a
   * future scheduler hook can run it on a slower cadence.
   */
  cleanupOlderThan(cutoffMs: number): number {
    const result = this.db
      .prepare('DELETE FROM mo_context_cache WHERE created_at < ?')
      .run(cutoffMs);
    return result.changes;
  }

  /** Inspect a single row by key without bumping hit_count. Tests +
   *  diagnostics use this; the production cache path always goes
   *  through `lookupExact` / `lookupSemantic`. */
  peek(cacheKey: string): MoContextCacheRow | null {
    const row = this.db
      .prepare<[string], Row>('SELECT * FROM mo_context_cache WHERE cache_key = ?')
      .get(cacheKey);
    return row ? rowToRecord(row) : null;
  }

  /** Count of live rows. Telemetry. */
  count(): number {
    const row = this.db
      .prepare<[], { c: number }>('SELECT COUNT(*) as c FROM mo_context_cache')
      .get();
    return row?.c ?? 0;
  }
}

/**
 * Build a deterministic cache key from the inputs that genuinely
 * affect the synthesised packet. SHA-256 → hex; ~64 chars per key,
 * collision-safe in any practical workspace.
 *
 * Inclusion list:
 *   - `taskId`: '' for question-only paths, ULID otherwise.
 *   - `taskBodyHash`: the task's current `notes.body` hash (use existing
 *      `hashBody` from mo-tier1.ts). Bumps on every meaningful edit.
 *   - `folderCatalogHash`: hash of the folder's `mo:catalog` body when
 *      folder-scoped. Empty string for unscoped/workspace queries.
 *   - `mode`: 'full' / 'resume' / 'ask' / 'thorough' / etc.
 *   - `scope`: 'folder' / 'workspace'.
 *   - `extra`: optional caller-defined string for any other axis (e.g.
 *      a question hash for question-only paths).
 *
 * Exclusion list (NOT in the key):
 *   - The calling MCP actor — Mo elevates internally; the packet shape
 *     is the same regardless of which MCP client asked.
 *   - Timestamps — TTL handles freshness, not the key.
 *   - User memory contents — Mo's persona/memory IS reflected in the
 *     packet but volatile enough that including it would defeat
 *     caching. Acceptable trade: a memory edit doesn't invalidate
 *     existing rows; the next non-cached call picks up the new memory.
 */
export function buildExactCacheKey(input: {
  taskId?: string | null;
  taskBodyHash?: string | null;
  folderCatalogHash?: string | null;
  mode: string;
  scope: string;
  extra?: string | null;
}): string {
  const parts = [
    input.taskId ?? '',
    input.taskBodyHash ?? '',
    input.folderCatalogHash ?? '',
    input.mode,
    input.scope,
    input.extra ?? '',
  ];
  // Use a separator that can't appear in any normal field (ULIDs,
  // hex hashes, mode strings) so the parts can't collide via
  // accidental concatenation.
  return createHash('sha256').update(parts.join('\x1f')).digest('hex');
}

/**
 * Cosine similarity between two equal-length Float32Array vectors.
 * Returns NaN when either vector has zero magnitude (caller should
 * treat as "no match"); identical vectors → 1.0; orthogonal → 0;
 * antiparallel → -1.
 *
 * Pure local arithmetic — no allocations on the hot path.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: dim mismatch (${a.length} vs ${b.length})`,
    );
  }
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    aMag += x * x;
    bMag += y * y;
  }
  if (aMag === 0 || bMag === 0) return NaN;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

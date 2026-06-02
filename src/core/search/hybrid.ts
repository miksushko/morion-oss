import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { Note, NoteSource, NoteStatus } from '../notes/types.js';
import { FtsIndex, type FtsHit } from './fts.js';
import { VecIndex, type VecHit } from './vec.js';

export interface SearchHit {
  note: Note;
  score: number;
  snippet: string | null;
}

export interface SearchOptions {
  limit?: number;
  folderId?: string | null;
  tag?: string;
  /** Default false. UI toggles this via "Show Archived"; MCP / Mo opt
   * in explicitly when the agent needs to surface archived content.
   * Always applied (even on unscoped searches) so archived notes can't
   * leak through the keyword path. */
  includeArchived?: boolean;
  /** Phase 6.7 v2: by default hide `mo:*` system notes (catalog,
   *  cluster, risks, patrol-log) from search results — they're
   *  machine-readable indices surfaced through Folder Settings
   *  tabs, not user prose. Power users debugging the indexing
   *  pipeline can flip this to true. */
  includeMoSystem?: boolean;
  /** ms-epoch lower bound on `created_at` (inclusive). */
  createdAfter?: number;
  /** ms-epoch upper bound on `created_at` (inclusive). */
  createdBefore?: number;
  /** ms-epoch lower bound on `updated_at` (inclusive). */
  updatedAfter?: number;
  /** ms-epoch upper bound on `updated_at` (inclusive). */
  updatedBefore?: number;
  /** Mo Indexing Redesign Phase 5a — restrict to notes assigned to
   *  any of these cluster ids via the `note_mo_clusters` JOIN. Many-to-
   *  many: a note matches if at least one of its cluster assignments
   *  is in the supplied list. Empty array short-circuits to zero hits.
   *  Used by `mo_search` to route a query through `mo:catalog` →
   *  pick relevant clusters → live search scoped to those clusters
   *  (the "indices augment search, never replace" invariant). */
  cluster?: string | string[];
}

const RRF_K = 60;

interface NoteRowWide {
  id: string;
  folder_id: string | null;
  title: string;
  body: string;
  pinned: number;
  source: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  archived_at: number | null;
  status: string;
  position: number | null;
  workflow_id: string | null;
  mcp_visible: number | null;
  mcp_update: number | null;
  mcp_delete: number | null;
  tag_names: string | null;
}

/**
 * Hybrid retrieval: BM25 (FTS5) + cosine distance (sqlite-vec) fused
 * with Reciprocal Rank Fusion. Falls back to FTS-only when the
 * embedding backend is unavailable.
 *
 * Soft-delete invariant (audit N18, 2026-04-16). Every query layer
 * that can return note ids enforces `deleted_at IS NULL`:
 *   1. FtsIndex.search  — JOIN notes, WHERE deleted_at IS NULL
 *   2. VecIndex.search  — JOIN notes, WHERE deleted_at IS NULL
 *   3. applyFilters     — WHERE deleted_at IS NULL (safety net)
 *   4. fetchNotes       — WHERE deleted_at IS NULL (safety net)
 *
 * The redundancy is deliberate defence-in-depth, not copy-paste.
 * If a future change bypasses one layer (e.g. a new vec-only path
 * that skips FtsIndex), the remaining layers still refuse to surface
 * a trashed note. `tests/search.test.ts` pins the invariant end-to-
 * end with a delete → search → expect-no-hit regression.
 */
export class HybridSearch {
  constructor(
    private readonly db: Database.Database,
    private readonly fts: FtsIndex,
    private readonly vec: VecIndex,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? 10;
    const overshoot = limit * 3;

    const ftsHits = this.fts.search(query, overshoot);

    const queryEmbedding = await this.embeddings.embed(query, 'query');
    const vecHits = queryEmbedding ? this.vec.search(queryEmbedding, overshoot) : [];

    const fused = rrfFuse(ftsHits, vecHits);

    // Always run applyFilters so archive exclusion + soft-delete safety
    // net hold even on unscoped searches. Earlier code skipped this when
    // no folderId/tag was set, which silently leaked archived notes
    // through the keyword path despite the SearchOptions docstring.
    const candidates = this.applyFilters(fused, options);

    const top = candidates.slice(0, limit);
    if (top.length === 0) return [];

    const noteMap = this.fetchNotes(top.map((c) => c.noteId));
    const snippetMap = new Map(ftsHits.map((h) => [h.noteId, h.snippet]));

    return top
      .map((c) => {
        const note = noteMap.get(c.noteId);
        if (!note) return null;
        return { note, score: c.score, snippet: snippetMap.get(c.noteId) ?? null };
      })
      .filter((x): x is SearchHit => x !== null);
  }

  private applyFilters(
    hits: { noteId: string; score: number }[],
    options: SearchOptions,
  ): { noteId: string; score: number }[] {
    if (hits.length === 0) return hits;
    const ids = hits.map((h) => h.noteId);
    const placeholders = ids.map(() => '?').join(',');

    const conditions: string[] = [`n.id IN (${placeholders})`, 'n.deleted_at IS NULL'];
    const params: (string | number)[] = [...ids];

    if (options.folderId !== undefined) {
      if (options.folderId === null) conditions.push('n.folder_id IS NULL');
      else {
        conditions.push('n.folder_id = ?');
        params.push(options.folderId);
      }
    }

    let sql = 'SELECT DISTINCT n.id FROM notes n';
    if (options.tag) {
      sql += ' JOIN note_tags nt ON nt.note_id = n.id JOIN tags t ON t.id = nt.tag_id';
      conditions.push('t.name = ?');
      params.push(options.tag);
    }
    if (options.cluster !== undefined) {
      const clusterIds = Array.isArray(options.cluster)
        ? options.cluster
        : [options.cluster];
      if (clusterIds.length === 0) {
        // Empty array → zero hits. The `note_mo_clusters.cluster_id IN ()`
        // expansion below would generate invalid SQL; short-circuit.
        return [];
      }
      sql += ' JOIN note_mo_clusters nmc ON nmc.note_id = n.id';
      const clusterPlaceholders = clusterIds.map(() => '?').join(',');
      conditions.push(`nmc.cluster_id IN (${clusterPlaceholders})`);
      params.push(...clusterIds);
    }
    if (!options.includeArchived) {
      sql += ' LEFT JOIN folders fx ON fx.id = n.folder_id';
      conditions.push('n.archived_at IS NULL');
      conditions.push('(fx.id IS NULL OR fx.archived_at IS NULL)');
    }
    // Phase 6.7 v2 — hide `mo:*` system notes from search hits by
    // default. They surface only through Folder Settings tabs and
    // direct getById/open flows. Add `?includeMoSystem=1` later if
    // the search UI needs an opt-in toggle.
    if (!options.includeMoSystem) {
      conditions.push("(n.source IS NULL OR n.source NOT LIKE 'mo:%')");
    }
    if (typeof options.createdAfter === 'number') {
      conditions.push('n.created_at >= ?');
      params.push(options.createdAfter);
    }
    if (typeof options.createdBefore === 'number') {
      conditions.push('n.created_at <= ?');
      params.push(options.createdBefore);
    }
    if (typeof options.updatedAfter === 'number') {
      conditions.push('n.updated_at >= ?');
      params.push(options.updatedAfter);
    }
    if (typeof options.updatedBefore === 'number') {
      conditions.push('n.updated_at <= ?');
      params.push(options.updatedBefore);
    }
    sql += ` WHERE ${conditions.join(' AND ')}`;

    const allowed = new Set(
      this.db.prepare(sql).all(...params).map((r) => (r as { id: string }).id),
    );
    return hits.filter((h) => allowed.has(h.noteId));
  }

  private fetchNotes(ids: string[]): Map<string, Note> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT n.id, n.folder_id, n.title, n.body, n.pinned, n.source,
                n.created_at, n.updated_at, n.deleted_at, n.archived_at,
                n.status, n.position, n.workflow_id,
                n.mcp_visible, n.mcp_update, n.mcp_delete,
                (SELECT GROUP_CONCAT(t.name, '\u0001')
                 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                 WHERE nt.note_id = n.id) AS tag_names
         FROM notes n
         WHERE n.id IN (${placeholders}) AND n.deleted_at IS NULL`,
      )
      .all(...ids) as NoteRowWide[];

    const map = new Map<string, Note>();
    for (const row of rows) {
      map.set(row.id, {
        id: row.id,
        folderId: row.folder_id,
        title: row.title,
        body: row.body,
        pinned: row.pinned === 1,
        source: row.source as NoteSource,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
        archivedAt: row.archived_at,
        status: row.status as NoteStatus,
        position: row.position,
        workflowId: row.workflow_id,
        tags: row.tag_names ? row.tag_names.split('\u0001') : [],
        mcpPermissions: {
          visible: row.mcp_visible === null ? null : row.mcp_visible === 1,
          update: row.mcp_update === null ? null : row.mcp_update === 1,
          delete: row.mcp_delete === null ? null : row.mcp_delete === 1,
        },
      });
    }
    return map;
  }
}

function rrfFuse(fts: FtsHit[], vec: VecHit[]): { noteId: string; score: number }[] {
  const scores = new Map<string, number>();
  fts.forEach((hit, i) => {
    scores.set(hit.noteId, (scores.get(hit.noteId) ?? 0) + 1 / (RRF_K + i));
  });
  vec.forEach((hit, i) => {
    scores.set(hit.noteId, (scores.get(hit.noteId) ?? 0) + 1 / (RRF_K + i));
  });
  return [...scores.entries()]
    .map(([noteId, score]) => ({ noteId, score }))
    .sort((a, b) => b.score - a.score);
}

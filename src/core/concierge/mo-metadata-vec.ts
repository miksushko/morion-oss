import type Database from 'better-sqlite3';

/**
 * Per-note Mo metadata embedding store. Mirrors {@link VecIndex}'s
 * structure but targets the `mo_metadata_vec` virtual table — embeddings
 * of `summary + ' ' + keywords.join(' ')` from `note_mo_metadata`.
 *
 * Why a SEPARATE table from `notes_vec`:
 *   - `notes_vec` embeds full body for hybrid search; same note's body
 *     embedding doesn't represent the Tier-1 summary's semantic gist.
 *   - Cheap-metadata-first ranking in `mo_get_context` wants similarity
 *     against the SUMMARY (what the note is about), not against the
 *     raw body (which mentions stuff incidentally).
 *   - Body and summary may diverge — Tier 1 rebuilds summary on body
 *     change, but the windows of staleness differ.
 *
 * No-op when sqlite-vec is unavailable. The whole context-gather path
 * gracefully degrades to FTS5-over-summary keyword search.
 */

export interface MetadataVecHit {
  noteId: string;
  distance: number;
}

interface VecRow {
  note_id: string;
  distance: number;
}

export class MoMetadataVecRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly enabled: boolean,
  ) {}

  /**
   * Insert or replace the embedding for one note. Mirrors the safety
   * guards from {@link VecIndex.upsert}: vec0 doesn't honour
   * INSERT OR REPLACE, so we DELETE+INSERT in a single transaction;
   * we also short-circuit if the underlying note has been soft-deleted
   * between Tier 1's async LLM call and this write (otherwise a stale
   * embedding rides through to the next full rebuild).
   *
   * Caller is responsible for computing the embedding via
   * `embeddings.embed(text, 'passage')` and skipping the call entirely
   * when the embedder returns null (provider unavailable).
   */
  upsert(noteId: string, embedding: Float32Array): void {
    if (!this.enabled) return;
    const buf = Buffer.from(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength,
    );
    const tx = this.db.transaction(() => {
      const live = this.db
        .prepare<[string], { one: 1 }>(
          'SELECT 1 AS one FROM notes WHERE id = ? AND deleted_at IS NULL',
        )
        .get(noteId);
      if (!live) return;
      this.db.prepare('DELETE FROM mo_metadata_vec WHERE note_id = ?').run(noteId);
      this.db
        .prepare('INSERT INTO mo_metadata_vec (note_id, embedding) VALUES (?, ?)')
        .run(noteId, buf);
    });
    tx();
  }

  delete(noteId: string): void {
    if (!this.enabled) return;
    this.db
      .prepare('DELETE FROM mo_metadata_vec WHERE note_id = ?')
      .run(noteId);
  }

  /**
   * Whether THIS note has a stored embedding. Used by the bootstrap
   * sweep to enqueue notes whose Tier 1 metadata exists but whose
   * embedding was never (yet) computed — covers fresh installs after
   * Phase 2 ships and the embedder/vec was disabled at original
   * Tier 1 run time.
   */
  has(noteId: string): boolean {
    if (!this.enabled) return false;
    const row = this.db
      .prepare<[string], { one: 1 }>(
        'SELECT 1 AS one FROM mo_metadata_vec WHERE note_id = ?',
      )
      .get(noteId);
    return row !== undefined;
  }

  /**
   * Cosine-nearest notes to the supplied query embedding. Optional
   * folder scope: when `folderId` is set, joins `notes` and filters to
   * that folder's notes (still excludes soft-deleted). Caller is
   * expected to have computed the query vector via
   * `embeddings.embed(query, 'query')` — the kind matters for E5
   * asymmetric models.
   *
   * `excludeNoteIds` lets the caller drop notes already represented
   * elsewhere in the candidate set (e.g. the source task itself when
   * gathering "similar notes").
   *
   * Returns `[]` when sqlite-vec is missing — never throws — so the
   * caller's fallback to keyword search is just an `if (hits.length === 0)`.
   */
  searchSimilar(
    embedding: Float32Array,
    opts: {
      limit: number;
      folderId?: string;
      excludeNoteIds?: string[];
    },
  ): MetadataVecHit[] {
    if (!this.enabled) return [];
    const buf = Buffer.from(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength,
    );

    // vec0 KNN is "filter on MATCH then top-k", and post-WHERE filtering
    // can drop hits below the requested k. Over-fetch to cushion the
    // exclude-list + folder filter; cap at a sensible upper bound to
    // protect against a caller passing limit=10000.
    const overFetch = Math.min(
      opts.limit * 4 + (opts.excludeNoteIds?.length ?? 0),
      500,
    );

    const baseRows = this.db
      .prepare<[Buffer, number], VecRow>(
        `SELECT v.note_id AS note_id, v.distance AS distance
           FROM mo_metadata_vec v
           JOIN notes n ON n.id = v.note_id
          WHERE v.embedding MATCH ?
            AND k = ?
            AND n.deleted_at IS NULL
          ORDER BY v.distance`,
      )
      .all(buf, overFetch);

    const exclude = new Set(opts.excludeNoteIds ?? []);
    const filtered: MetadataVecHit[] = [];
    for (const row of baseRows) {
      if (exclude.has(row.note_id)) continue;
      if (opts.folderId !== undefined) {
        const inFolder = this.db
          .prepare<[string, string], { one: 1 }>(
            'SELECT 1 AS one FROM notes WHERE id = ? AND folder_id = ?',
          )
          .get(row.note_id, opts.folderId);
        if (!inFolder) continue;
      }
      filtered.push({ noteId: row.note_id, distance: row.distance });
      if (filtered.length >= opts.limit) break;
    }
    return filtered;
  }
}

/**
 * Build the text that gets embedded for a note's Mo metadata vector.
 * Joining summary + keywords gives the embedder both the prose gist
 * and the explicit keyword anchors — keywords by themselves underfit
 * (one-word context), summary alone misses the explicit term anchors
 * Tier 1 found semantically important. Caller passes both fresh from
 * `note_mo_metadata` post-upsert.
 *
 * Returns null when there's nothing meaningful to embed (empty summary
 * AND no keywords) so the caller can skip the embedder call entirely.
 */
export function buildMoMetadataEmbedText(
  summary: string,
  keywords: readonly string[],
): string | null {
  const trimmedSummary = summary.trim();
  const joinedKeywords = keywords
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .join(' ');
  if (trimmedSummary.length === 0 && joinedKeywords.length === 0) return null;
  if (trimmedSummary.length === 0) return joinedKeywords;
  if (joinedKeywords.length === 0) return trimmedSummary;
  return `${trimmedSummary} ${joinedKeywords}`;
}

/**
 * Find notes whose Tier 1 metadata exists but whose embedding row is
 * missing — backfill candidates for the indexing tick's embedding
 * sweep. Filters out:
 *   - soft-deleted notes
 *   - archived notes / notes in archived folders
 *   - mo:* system notes (mirrors Tier 1's own filter)
 *   - notes in folders without Mo enabled
 * Returns at most `limit` ids ordered by metadata `updated_at` DESC
 * so freshly-summarised notes get their embedding written before
 * legacy backlog. Cheap deterministic SQL — no LLM, no embedder call.
 */
export function listMoMetadataVecBackfillCandidates(
  db: import('better-sqlite3').Database,
  limit: number,
): Array<{ noteId: string; summary: string; keywords: string[] }> {
  interface Row {
    note_id: string;
    summary: string;
    keywords: string;
  }
  const rows = db
    .prepare<[number], Row>(
      `SELECT m.note_id AS note_id,
              m.summary AS summary,
              m.keywords AS keywords
         FROM note_mo_metadata m
         JOIN notes n ON n.id = m.note_id
         JOIN concierge_folder_settings cfs ON cfs.folder_id = n.folder_id
         LEFT JOIN folders f ON f.id = n.folder_id
         LEFT JOIN mo_metadata_vec v ON v.note_id = m.note_id
        WHERE v.note_id IS NULL
          AND n.deleted_at IS NULL
          AND n.archived_at IS NULL
          AND (f.archived_at IS NULL)
          AND cfs.enabled = 1
          AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
        ORDER BY m.updated_at DESC
        LIMIT ?`,
    )
    .all(limit);
  return rows.map((r) => {
    let keywords: string[] = [];
    try {
      const parsed = JSON.parse(r.keywords) as unknown;
      if (Array.isArray(parsed)) {
        keywords = parsed.filter((s): s is string => typeof s === 'string');
      }
    } catch {
      // Malformed keywords JSON — embed summary alone, don't crash the
      // sweep. The next Tier 1 run will rewrite the row cleanly.
    }
    return { noteId: r.note_id, summary: r.summary, keywords };
  });
}

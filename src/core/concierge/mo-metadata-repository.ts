import type Database from 'better-sqlite3';

/**
 * Mo Indexing Redesign — Phase 1 storage.
 *
 * Per-note metadata cache: summary, keywords, body_hash for dirty
 * detection, who/when computed, confidence, and the `mo_hands_off`
 * opt-out flag. Distinct from the `notes` table so writes here do NOT
 * bump `notes.updated_at` and do NOT fire `note_changed` events —
 * otherwise Tier 1 self-triggers a feedback loop (precedent:
 * `01KQ2BVN19Z46HKJ7V8GSAYTZJ` live-sync refetch storm).
 *
 * Cluster assignment lives in a separate many-to-many table
 * (`note_mo_clusters`) — see {@link NoteMoClustersRepository}.
 *
 * `body_hash` is the dirty-detection key. Workers check the current
 * note body hash against the cached hash before recomputing — if equal,
 * skip; if different, recompute and overwrite.
 */

export type MoComputedBy =
  | 'tier0'           // deterministic SQL-only
  | 'tier1'           // cheap cloud per-note map
  | 'mo-sync'         // computed inline by Mo during a write tool (mo_record etc.)
  | 'local'           // Tier -1 local instant model
  | 'local+verified'  // local computed, then cloud confirmed high-confidence
  | 'cloud'           // cloud overwrote a low-confidence local result
  | 'user';           // user hand-edited via Meta Data tab

export interface NoteMoMetadata {
  noteId: string;
  summary: string;
  keywords: string[];
  bodyHash: string | null;
  computedBy: MoComputedBy | null;
  computedAt: number | null;
  confidence: number | null;
  moHandsOff: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertMoMetadataInput {
  noteId: string;
  summary?: string;
  keywords?: string[];
  bodyHash?: string | null;
  computedBy?: MoComputedBy | null;
  computedAt?: number | null;
  confidence?: number | null;
  moHandsOff?: boolean;
}

interface Row {
  note_id: string;
  summary: string;
  keywords: string;
  body_hash: string | null;
  computed_by: string | null;
  computed_at: number | null;
  confidence: number | null;
  mo_hands_off: number;
  created_at: number;
  updated_at: number;
}

function rowToMetadata(row: Row): NoteMoMetadata {
  let keywords: string[] = [];
  try {
    const parsed = JSON.parse(row.keywords) as unknown;
    if (Array.isArray(parsed)) {
      keywords = parsed.filter((s): s is string => typeof s === 'string');
    }
  } catch {
    keywords = [];
  }
  return {
    noteId: row.note_id,
    summary: row.summary,
    keywords,
    bodyHash: row.body_hash,
    computedBy: (row.computed_by ?? null) as MoComputedBy | null,
    computedAt: row.computed_at,
    confidence: row.confidence,
    moHandsOff: row.mo_hands_off === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class NoteMoMetadataRepository {
  constructor(private readonly db: Database.Database) {}

  get(noteId: string): NoteMoMetadata | null {
    const row = this.db
      .prepare<[string], Row>('SELECT * FROM note_mo_metadata WHERE note_id = ?')
      .get(noteId);
    return row ? rowToMetadata(row) : null;
  }

  /**
   * Batch-fetch metadata for many notes in one SQL round-trip. Notes
   * without a `note_mo_metadata` row are simply absent from the map —
   * callers should treat missing as "Tier 1 hasn't run on this note
   * yet" and surface `summary: null` / `keywords: null` accordingly.
   *
   * The metadata-first context-gather path (mo_get_context, mo_search,
   * notes_search?withMetadata) calls this for hit sets up to ~50 notes;
   * a per-note `get()` would be N+1.
   */
  getMany(noteIds: string[]): Map<string, NoteMoMetadata> {
    const out = new Map<string, NoteMoMetadata>();
    if (noteIds.length === 0) return out;
    // SQLite's default SQLITE_MAX_VARIABLE_NUMBER is 32766 on modern
    // builds — well above any realistic hit set, so a single IN-clause
    // is fine.
    const placeholders = noteIds.map(() => '?').join(',');
    const rows = this.db
      .prepare<string[], Row>(
        `SELECT * FROM note_mo_metadata WHERE note_id IN (${placeholders})`,
      )
      .all(...noteIds);
    for (const row of rows) {
      out.set(row.note_id, rowToMetadata(row));
    }
    return out;
  }

  /**
   * Insert or update per-note metadata. Only the fields present on
   * `input` are touched — others retain their stored value (or default
   * for a fresh insert). Caller controls `now` so tests can pin
   * timestamps.
   */
  upsert(input: UpsertMoMetadataInput, now: number = Date.now()): NoteMoMetadata {
    const existing = this.get(input.noteId);
    const summary = input.summary ?? existing?.summary ?? '';
    const keywords = input.keywords ?? existing?.keywords ?? [];
    const bodyHash =
      input.bodyHash !== undefined ? input.bodyHash : existing?.bodyHash ?? null;
    const computedBy =
      input.computedBy !== undefined ? input.computedBy : existing?.computedBy ?? null;
    const computedAt =
      input.computedAt !== undefined ? input.computedAt : existing?.computedAt ?? null;
    const confidence =
      input.confidence !== undefined ? input.confidence : existing?.confidence ?? null;
    const moHandsOff =
      input.moHandsOff !== undefined ? input.moHandsOff : existing?.moHandsOff ?? false;

    if (existing) {
      this.db
        .prepare(
          `UPDATE note_mo_metadata
              SET summary = ?,
                  keywords = ?,
                  body_hash = ?,
                  computed_by = ?,
                  computed_at = ?,
                  confidence = ?,
                  mo_hands_off = ?,
                  updated_at = ?
            WHERE note_id = ?`,
        )
        .run(
          summary,
          JSON.stringify(keywords),
          bodyHash,
          computedBy,
          computedAt,
          confidence,
          moHandsOff ? 1 : 0,
          now,
          input.noteId,
        );
      return {
        noteId: input.noteId,
        summary,
        keywords,
        bodyHash,
        computedBy,
        computedAt,
        confidence,
        moHandsOff,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
    }

    this.db
      .prepare(
        `INSERT INTO note_mo_metadata
           (note_id, summary, keywords, body_hash, computed_by, computed_at,
            confidence, mo_hands_off, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.noteId,
        summary,
        JSON.stringify(keywords),
        bodyHash,
        computedBy,
        computedAt,
        confidence,
        moHandsOff ? 1 : 0,
        now,
        now,
      );

    return {
      noteId: input.noteId,
      summary,
      keywords,
      bodyHash,
      computedBy,
      computedAt,
      confidence,
      moHandsOff,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Toggle the user's "Mo, don't touch this note" opt-out flag. */
  setHandsOff(noteId: string, value: boolean, now: number = Date.now()): void {
    this.upsert({ noteId, moHandsOff: value }, now);
  }

  /** True iff the cached body_hash matches the supplied one. False on
   * missing row or mismatch — both mean Tier 1 needs to recompute. */
  isFresh(noteId: string, bodyHash: string): boolean {
    const row = this.db
      .prepare<[string], { body_hash: string | null }>(
        'SELECT body_hash FROM note_mo_metadata WHERE note_id = ?',
      )
      .get(noteId);
    return Boolean(row && row.body_hash === bodyHash);
  }

  delete(noteId: string): void {
    this.db.prepare('DELETE FROM note_mo_metadata WHERE note_id = ?').run(noteId);
  }
}

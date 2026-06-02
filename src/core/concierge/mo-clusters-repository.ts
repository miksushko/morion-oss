import type Database from 'better-sqlite3';

/**
 * Mo Indexing Redesign — many-to-many cluster assignment.
 *
 * One note legitimately belongs to several themes simultaneously (a
 * ticket about "Mo chat tool-call sequence bug" fits `mo-chat-loop` +
 * `mcp-surface` + `infra-bugs`). Modeling cluster as a singular field
 * on `note_mo_metadata` would force miscategorization on cross-cutting
 * tickets and break once Tier 1 emits multiple cluster candidates.
 *
 * `cluster_id` is a free-form string, not a FK. The set of cluster ids
 * per folder is derived from the population of this table plus the
 * per-folder Tasks Topics tab (Phase 6 UI). If a normalized clusters
 * table with descriptions / per-cluster house rules is needed later,
 * it can be added without breaking this JOIN.
 *
 * `source` discriminates how the assignment got here:
 *   - 'tier0'    — deterministic (e.g. tag-mirror, ULID match)
 *   - 'tier1'    — cheap-model proposed candidate
 *   - 'user'     — explicit human override via UI / mo_reclassify
 *   - 'imported' — bulk import / migration
 *   - 'verified' — Tier 1 proposed, then mid-tier confirmed
 *
 * `confidence` is 0..1; user overrides are 1.0 by convention.
 */

export type MoClusterSource =
  | 'tier0'
  | 'tier1'
  | 'user'
  | 'imported'
  | 'verified';

export interface NoteCluster {
  noteId: string;
  clusterId: string;
  confidence: number;
  source: MoClusterSource;
  updatedAt: number;
}

export interface UpsertClusterInput {
  noteId: string;
  clusterId: string;
  confidence?: number;
  source: MoClusterSource;
}

interface Row {
  note_id: string;
  cluster_id: string;
  confidence: number;
  source: string;
  updated_at: number;
}

function rowToCluster(row: Row): NoteCluster {
  return {
    noteId: row.note_id,
    clusterId: row.cluster_id,
    confidence: row.confidence,
    source: row.source as MoClusterSource,
    updatedAt: row.updated_at,
  };
}

export class NoteMoClustersRepository {
  constructor(private readonly db: Database.Database) {}

  /** All cluster assignments for one note (zero or many). */
  listForNote(noteId: string): NoteCluster[] {
    return this.db
      .prepare<[string], Row>(
        'SELECT * FROM note_mo_clusters WHERE note_id = ? ORDER BY confidence DESC, cluster_id',
      )
      .all(noteId)
      .map(rowToCluster);
  }

  /**
   * Batch cluster lookup for many notes at once. Returns `noteId →
   * clusterId[]` (sorted by confidence DESC, then by cluster_id for
   * stable order). Notes with no assignments are absent from the map;
   * callers should treat missing as `[]`.
   *
   * Replaces the per-note `listForNote` loop in hot paths like
   * `mo_search` / `mo_get_context` Wave 2 candidate enrichment, which
   * otherwise N+1 over hit sets up to ~50 notes.
   */
  listClusterIdsForNotes(noteIds: string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (noteIds.length === 0) return out;
    const placeholders = noteIds.map(() => '?').join(',');
    const rows = this.db
      .prepare<string[], { note_id: string; cluster_id: string }>(
        `SELECT note_id, cluster_id FROM note_mo_clusters
          WHERE note_id IN (${placeholders})
          ORDER BY confidence DESC, cluster_id`,
      )
      .all(...noteIds);
    for (const row of rows) {
      const list = out.get(row.note_id);
      if (list) list.push(row.cluster_id);
      else out.set(row.note_id, [row.cluster_id]);
    }
    return out;
  }

  /** All notes assigned to a cluster id. */
  listForCluster(clusterId: string): NoteCluster[] {
    return this.db
      .prepare<[string], Row>(
        'SELECT * FROM note_mo_clusters WHERE cluster_id = ? ORDER BY confidence DESC, note_id',
      )
      .all(clusterId)
      .map(rowToCluster);
  }

  /** Note ids assigned to ANY of the supplied cluster ids — convenience
   *  for `SearchOptions.cluster?: string | string[]` filter. */
  noteIdsInClusters(clusterIds: string[]): string[] {
    if (clusterIds.length === 0) return [];
    const placeholders = clusterIds.map(() => '?').join(',');
    const rows = this.db
      .prepare<string[], { note_id: string }>(
        `SELECT DISTINCT note_id FROM note_mo_clusters WHERE cluster_id IN (${placeholders})`,
      )
      .all(...clusterIds);
    return rows.map((r) => r.note_id);
  }

  /** Distinct cluster ids appearing in any assignment. Used by the
   *  catalog writer + Tasks Topics UI to enumerate live clusters. */
  listAllClusterIds(): string[] {
    return this.db
      .prepare<[], { cluster_id: string }>(
        'SELECT DISTINCT cluster_id FROM note_mo_clusters ORDER BY cluster_id',
      )
      .all()
      .map((r) => r.cluster_id);
  }

  /** Distinct cluster ids assigned to notes in ONE folder. Per-folder
   *  scope is required for Tier 1 prompt seeding — cluster ids are
   *  namespaced per folder (Case 26), and feeding cross-folder ids to
   *  the classifier would let folder A's `kanban-ui` leak into folder
   *  B's note classification. Filters out soft-deleted notes AND
   *  `mo:*` system notes — Mo's own index storage must never appear
   *  as a topic suggestion (ticket 01KQKESWXPYV73V9FE614Q51HQ). */
  listClusterIdsForFolder(folderId: string): string[] {
    return this.db
      .prepare<[string], { cluster_id: string }>(
        `SELECT DISTINCT c.cluster_id
           FROM note_mo_clusters c
           JOIN notes n ON n.id = c.note_id
          WHERE n.folder_id = ?
            AND n.deleted_at IS NULL
            AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
          ORDER BY c.cluster_id`,
      )
      .all(folderId)
      .map((r) => r.cluster_id);
  }

  /**
   * Insert or update one assignment. PK is `(note_id, cluster_id)`,
   * so re-asserting the same pair updates `confidence` / `source` /
   * `updated_at`. A note can hold many rows — call once per cluster.
   */
  upsert(input: UpsertClusterInput, now: number = Date.now()): NoteCluster {
    const confidence = input.confidence ?? (input.source === 'user' ? 1.0 : 0.8);
    this.db
      .prepare(
        `INSERT INTO note_mo_clusters (note_id, cluster_id, confidence, source, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(note_id, cluster_id) DO UPDATE SET
           confidence = excluded.confidence,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      )
      .run(input.noteId, input.clusterId, confidence, input.source, now);
    return {
      noteId: input.noteId,
      clusterId: input.clusterId,
      confidence,
      source: input.source,
      updatedAt: now,
    };
  }

  /**
   * Replace a note's full cluster set in one transaction. Useful when
   * Tier 1 emits a fresh `cluster_candidates[]` list — caller decides
   * whether to keep prior `source='user'` rows (defaults to keeping
   * them) or replace everything.
   */
  replaceForNote(
    noteId: string,
    assignments: Array<{ clusterId: string; confidence?: number; source: MoClusterSource }>,
    options: { preserveUserOverrides?: boolean } = { preserveUserOverrides: true },
    now: number = Date.now(),
  ): NoteCluster[] {
    const tx = this.db.transaction(
      (
        nid: string,
        rows: Array<{ clusterId: string; confidence?: number; source: MoClusterSource }>,
      ) => {
        if (options.preserveUserOverrides) {
          this.db
            .prepare("DELETE FROM note_mo_clusters WHERE note_id = ? AND source != 'user'")
            .run(nid);
        } else {
          this.db.prepare('DELETE FROM note_mo_clusters WHERE note_id = ?').run(nid);
        }
        const insert = this.db.prepare(
          `INSERT INTO note_mo_clusters (note_id, cluster_id, confidence, source, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(note_id, cluster_id) DO UPDATE SET
             confidence = excluded.confidence,
             source = excluded.source,
             updated_at = excluded.updated_at`,
        );
        for (const r of rows) {
          const confidence = r.confidence ?? (r.source === 'user' ? 1.0 : 0.8);
          insert.run(nid, r.clusterId, confidence, r.source, now);
        }
      },
    );
    tx(noteId, assignments);
    return this.listForNote(noteId);
  }

  /** Remove one assignment. */
  remove(noteId: string, clusterId: string): void {
    this.db
      .prepare('DELETE FROM note_mo_clusters WHERE note_id = ? AND cluster_id = ?')
      .run(noteId, clusterId);
  }

  /** Bulk-rename a cluster id (used by `mo_rename_cluster` MCP tool in
   *  Phase 5). Updates `updated_at` on every touched row. */
  renameCluster(fromId: string, toId: string, now: number = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE note_mo_clusters
            SET cluster_id = ?, updated_at = ?
          WHERE cluster_id = ?`,
      )
      .run(toId, now, fromId);
    return result.changes;
  }
}

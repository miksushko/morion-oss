import type Database from 'better-sqlite3';

/**
 * Mo Indexing Redesign — event-driven patrol queues.
 *
 * Two SQLite-durable queues underpin Phase 2+ workers:
 *
 *  - `mo_metadata_queue`  — per-note dirty queue (Tier 1 + Tier 0
 *    items). Bursts of edits coalesce on `(folder_id, note_id, tier)`
 *    via `ON CONFLICT DO UPDATE` — five edits to one note in a series
 *    collapse to one work-item carrying the latest body_hash.
 *
 *  - `mo_cluster_queue`   — per-cluster regen queue (Tier 2 + 2.5).
 *    Triggered after Tier 1 settles for that cluster's dirty notes
 *    with a longer debounce than per-note work.
 *
 * Worker contract (enforced at the worker layer, not this repo):
 *   1. `claim()` takes the oldest `picked_at IS NULL` rows up to a
 *      bounded batch size and stamps `picked_at = now`.
 *   2. Worker rechecks `notes.body` SHA against the row's `body_hash`
 *      and skips if equal (stale dirty-mark, another writer raced in).
 *   3. On success, `complete()` deletes the row.
 *   4. On failure, `release()` clears `picked_at`, increments
 *      `attempts`, and the row becomes available for another worker
 *      after backoff.
 *   5. After N failed attempts a stuck row gets logged to
 *      `mo:patrol-log` and abandoned (Phase 2+ wires this).
 *
 * Archived folders: workers filter via `folder.archived_at IS NOT NULL`
 * before claiming. The queue itself doesn't enforce this — archive is
 * a separate concept and metadata for archived folders should remain
 * intact. Frozen, but not deleted.
 */

export type MoQueueTier = 'tier0' | 'tier1' | 'tier-1';

export interface MoMetadataQueueRow {
  folderId: string;
  noteId: string;
  tier: MoQueueTier;
  bodyHash: string;
  dirtySince: number;
  pickedAt: number | null;
  attempts: number;
}

export interface MoClusterQueueRow {
  folderId: string;
  clusterId: string;
  dirtySince: number;
  pickedAt: number | null;
  attempts: number;
}

interface MetadataRow {
  folder_id: string;
  note_id: string;
  tier: string;
  body_hash: string;
  dirty_since: number;
  picked_at: number | null;
  attempts: number;
}

interface ClusterRow {
  folder_id: string;
  cluster_id: string;
  dirty_since: number;
  picked_at: number | null;
  attempts: number;
}

function metadataRow(row: MetadataRow): MoMetadataQueueRow {
  return {
    folderId: row.folder_id,
    noteId: row.note_id,
    tier: row.tier as MoQueueTier,
    bodyHash: row.body_hash,
    dirtySince: row.dirty_since,
    pickedAt: row.picked_at,
    attempts: row.attempts,
  };
}

function clusterRow(row: ClusterRow): MoClusterQueueRow {
  return {
    folderId: row.folder_id,
    clusterId: row.cluster_id,
    dirtySince: row.dirty_since,
    pickedAt: row.picked_at,
    attempts: row.attempts,
  };
}

export class MoMetadataQueueRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Coalescing enqueue. If `(folder_id, note_id, tier)` already
   * exists, refresh `body_hash` + `dirty_since` and reset
   * `picked_at`/`attempts` so the latest edit gets a fresh attempt.
   */
  enqueue(
    folderId: string,
    noteId: string,
    tier: MoQueueTier,
    bodyHash: string,
    now: number = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO mo_metadata_queue
           (folder_id, note_id, tier, body_hash, dirty_since, picked_at, attempts)
         VALUES (?, ?, ?, ?, ?, NULL, 0)
         ON CONFLICT(folder_id, note_id, tier) DO UPDATE SET
           body_hash = excluded.body_hash,
           dirty_since = excluded.dirty_since,
           picked_at = NULL,
           attempts = 0`,
      )
      .run(folderId, noteId, tier, bodyHash, now);
  }

  /**
   * Pull up to `limit` available rows ordered by `dirty_since` ASC
   * (oldest first), filtered by tier, stamped with `picked_at = now`
   * to prevent another worker from grabbing them. Returns the claimed
   * rows. Atomic via SQLite transaction.
   */
  claim(tier: MoQueueTier, limit: number, now: number = Date.now()): MoMetadataQueueRow[] {
    const tx = this.db.transaction((tierArg: MoQueueTier, limitArg: number) => {
      const rows = this.db
        .prepare<[string, number], MetadataRow>(
          `SELECT * FROM mo_metadata_queue
            WHERE tier = ? AND picked_at IS NULL
            ORDER BY dirty_since ASC
            LIMIT ?`,
        )
        .all(tierArg, limitArg);
      if (rows.length === 0) return [];
      const claimStmt = this.db.prepare(
        `UPDATE mo_metadata_queue
            SET picked_at = ?
          WHERE folder_id = ? AND note_id = ? AND tier = ?
            AND picked_at IS NULL`,
      );
      const claimed: MoMetadataQueueRow[] = [];
      for (const row of rows) {
        const r = claimStmt.run(now, row.folder_id, row.note_id, row.tier);
        if (r.changes === 1) {
          claimed.push(metadataRow({ ...row, picked_at: now }));
        }
      }
      return claimed;
    });
    return tx(tier, limit);
  }

  /** Mark a claimed row as done. Removes it from the queue. */
  complete(folderId: string, noteId: string, tier: MoQueueTier): void {
    this.db
      .prepare(
        `DELETE FROM mo_metadata_queue
          WHERE folder_id = ? AND note_id = ? AND tier = ?`,
      )
      .run(folderId, noteId, tier);
  }

  /** Release a claim back to the available pool, bump attempts. */
  release(folderId: string, noteId: string, tier: MoQueueTier): void {
    this.db
      .prepare(
        `UPDATE mo_metadata_queue
            SET picked_at = NULL,
                attempts = attempts + 1
          WHERE folder_id = ? AND note_id = ? AND tier = ?`,
      )
      .run(folderId, noteId, tier);
  }

  /** Pending (unclaimed) row count for a folder + tier — observability. */
  pendingCount(folderId: string, tier: MoQueueTier): number {
    const row = this.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM mo_metadata_queue
          WHERE folder_id = ? AND tier = ? AND picked_at IS NULL`,
      )
      .get(folderId, tier);
    return row?.c ?? 0;
  }

  /** All rows for one folder — debugging + manual patrol-now flows. */
  listForFolder(folderId: string): MoMetadataQueueRow[] {
    return this.db
      .prepare<[string], MetadataRow>(
        `SELECT * FROM mo_metadata_queue
          WHERE folder_id = ?
          ORDER BY dirty_since ASC`,
      )
      .all(folderId)
      .map(metadataRow);
  }

  /** Drop everything for a folder — used when Mo gets disabled on a
   *  folder mid-queue, or for tests. */
  clearFolder(folderId: string): void {
    this.db.prepare('DELETE FROM mo_metadata_queue WHERE folder_id = ?').run(folderId);
  }

  /**
   * Self-recovery: release every claim older than `staleMs` so the
   * next worker can pick those rows up. A claim "stuck" because
   * the previous worker died mid-LLM (process restart, app crash,
   * SIGKILL) would otherwise sit in the queue forever — `picked_at`
   * never clears, `claim()` filters it out, and the row becomes
   * permanently invisible. Called at the start of every
   * `runMoIndexingTick` with a 5-minute default threshold (longer
   * than any reasonable LLM call). Returns the number of released
   * rows for observability. Does NOT bump `attempts` — the
   * previous attempt might have actually succeeded right before
   * the crash, and double-counting would push otherwise-fine rows
   * into the abandon bucket.
   */
  releaseStuck(staleMs: number, now: number = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE mo_metadata_queue
            SET picked_at = NULL
          WHERE picked_at IS NOT NULL AND picked_at < ?`,
      )
      .run(now - staleMs);
    return result.changes;
  }
}

export class MoClusterQueueRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Mark a cluster as dirty. Coalesces on `(folder_id, cluster_id)`
   * — repeated dirty signals refresh `dirty_since` so the worker's
   * debounce fires from the latest signal, not the earliest.
   */
  enqueue(folderId: string, clusterId: string, now: number = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO mo_cluster_queue
           (folder_id, cluster_id, dirty_since, picked_at, attempts)
         VALUES (?, ?, ?, NULL, 0)
         ON CONFLICT(folder_id, cluster_id) DO UPDATE SET
           dirty_since = excluded.dirty_since,
           picked_at = NULL,
           attempts = 0`,
      )
      .run(folderId, clusterId, now);
  }

  /**
   * Claim cluster regen rows whose `dirty_since` is older than
   * `olderThan` — Tier 2 wants a longer debounce so bursts of Tier 1
   * completions in one cluster collapse to a single regen.
   */
  claim(
    olderThan: number,
    limit: number,
    now: number = Date.now(),
  ): MoClusterQueueRow[] {
    const tx = this.db.transaction((olderThanArg: number, limitArg: number) => {
      const rows = this.db
        .prepare<[number, number], ClusterRow>(
          `SELECT * FROM mo_cluster_queue
            WHERE picked_at IS NULL AND dirty_since <= ?
            ORDER BY dirty_since ASC
            LIMIT ?`,
        )
        .all(olderThanArg, limitArg);
      if (rows.length === 0) return [];
      const claimStmt = this.db.prepare(
        `UPDATE mo_cluster_queue
            SET picked_at = ?
          WHERE folder_id = ? AND cluster_id = ?
            AND picked_at IS NULL`,
      );
      const claimed: MoClusterQueueRow[] = [];
      for (const row of rows) {
        const r = claimStmt.run(now, row.folder_id, row.cluster_id);
        if (r.changes === 1) {
          claimed.push(clusterRow({ ...row, picked_at: now }));
        }
      }
      return claimed;
    });
    return tx(olderThan, limit);
  }

  complete(folderId: string, clusterId: string): void {
    this.db
      .prepare(
        'DELETE FROM mo_cluster_queue WHERE folder_id = ? AND cluster_id = ?',
      )
      .run(folderId, clusterId);
  }

  release(folderId: string, clusterId: string): void {
    this.db
      .prepare(
        `UPDATE mo_cluster_queue
            SET picked_at = NULL,
                attempts = attempts + 1
          WHERE folder_id = ? AND cluster_id = ?`,
      )
      .run(folderId, clusterId);
  }

  pendingCount(folderId: string): number {
    const row = this.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM mo_cluster_queue
          WHERE folder_id = ? AND picked_at IS NULL`,
      )
      .get(folderId);
    return row?.c ?? 0;
  }

  listForFolder(folderId: string): MoClusterQueueRow[] {
    return this.db
      .prepare<[string], ClusterRow>(
        `SELECT * FROM mo_cluster_queue
          WHERE folder_id = ?
          ORDER BY dirty_since ASC`,
      )
      .all(folderId)
      .map(clusterRow);
  }

  clearFolder(folderId: string): void {
    this.db.prepare('DELETE FROM mo_cluster_queue WHERE folder_id = ?').run(folderId);
  }

  /**
   * Self-recovery: same as the metadata-queue counterpart — release
   * claims older than `staleMs` so a crashed worker doesn't leave
   * cluster regens permanently stuck. See `MoMetadataQueueRepository.releaseStuck`
   * for the rationale.
   */
  releaseStuck(staleMs: number, now: number = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE mo_cluster_queue
            SET picked_at = NULL
          WHERE picked_at IS NOT NULL AND picked_at < ?`,
      )
      .run(now - staleMs);
    return result.changes;
  }
}

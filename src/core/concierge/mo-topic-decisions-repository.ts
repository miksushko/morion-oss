import type Database from 'better-sqlite3';

/**
 * Mo Indexing — topic-cleanup decision memory.
 *
 * Backed by `mo_topic_decisions` (migration 0024). One row per
 * (folderId, sourceCluster, targetCluster) — captures every merge /
 * keep-separate / demote-to-tag decision so subsequent hygiene passes
 * don't re-propose the same pair.
 *
 * Decisions are FINAL. Restoring a previous decision (e.g. "I changed
 * my mind, please re-consider this pair") goes through `forget()`,
 * which deletes the row. Cleanup will then be free to re-propose it.
 *
 * Per the Case 26 lesson, keys include `folderId` — `kanban-ui` lives
 * independently in each folder and decisions never cross folder
 * boundaries.
 */

export type TopicDecision = 'merged' | 'kept_separate' | 'demote_tag';
export type TopicDecisionAuthor = 'auto' | 'user';

export interface TopicDecisionRow {
  folderId: string;
  sourceCluster: string;
  /** null for `demote_tag` decisions (no merge target). */
  targetCluster: string | null;
  decision: TopicDecision;
  decidedBy: TopicDecisionAuthor;
  decidedAt: number;
  reason: string;
}

interface Row {
  folder_id: string;
  source_cluster: string;
  target_cluster: string | null;
  decision: TopicDecision;
  decided_by: TopicDecisionAuthor;
  decided_at: number;
  reason: string;
}

function rowTo(row: Row): TopicDecisionRow {
  // Storage uses empty string for the demote-tag target so SQLite PK
  // semantics behave reliably across versions (NULLs in PKs are an
  // engine-version trap). Translate back to null on read so the
  // public contract — "demote_tag rows have no target" — holds.
  const target =
    row.target_cluster && row.target_cluster.length > 0
      ? row.target_cluster
      : null;
  return {
    folderId: row.folder_id,
    sourceCluster: row.source_cluster,
    targetCluster: target,
    decision: row.decision,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    reason: row.reason ?? '',
  };
}

export class MoTopicDecisionsRepository {
  constructor(private readonly db: Database.Database) {}

  /** Record a decision. Idempotent on `(folder, source, target)` —
   *  re-recording overwrites the prior row (keeps the most recent
   *  reason / decidedBy / decidedAt). target is normalised to `''`
   *  for `demote_tag` so the PK works correctly (SQLite NULLs in PK
   *  are weird across versions; empty string is unambiguous and
   *  rowTo translates back to null). */
  record(input: {
    folderId: string;
    sourceCluster: string;
    targetCluster: string | null;
    decision: TopicDecision;
    decidedBy: TopicDecisionAuthor;
    decidedAt?: number;
    reason?: string;
  }): TopicDecisionRow {
    const decidedAt = input.decidedAt ?? Date.now();
    const targetKey = input.targetCluster ?? '';
    this.db
      .prepare(
        `INSERT INTO mo_topic_decisions
           (folder_id, source_cluster, target_cluster, decision, decided_by, decided_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(folder_id, source_cluster, target_cluster) DO UPDATE SET
           decision = excluded.decision,
           decided_by = excluded.decided_by,
           decided_at = excluded.decided_at,
           reason = excluded.reason`,
      )
      .run(
        input.folderId,
        input.sourceCluster,
        targetKey,
        input.decision,
        input.decidedBy,
        decidedAt,
        input.reason ?? '',
      );
    return {
      folderId: input.folderId,
      sourceCluster: input.sourceCluster,
      targetCluster: input.targetCluster,
      decision: input.decision,
      decidedBy: input.decidedBy,
      decidedAt,
      reason: input.reason ?? '',
    };
  }

  /** Look up a single decision. `targetCluster=null` matches the
   *  demote-tag row for the source. */
  get(
    folderId: string,
    sourceCluster: string,
    targetCluster: string | null,
  ): TopicDecisionRow | null {
    const row = this.db
      .prepare<[string, string, string], Row>(
        `SELECT * FROM mo_topic_decisions
          WHERE folder_id = ? AND source_cluster = ? AND target_cluster = ?`,
      )
      .get(folderId, sourceCluster, targetCluster ?? '');
    return row ? rowTo(row) : null;
  }

  /** Has this folder ALREADY decided anything about this source
   *  cluster (regardless of target)? Used by the hygiene proposer to
   *  short-circuit pairs the user has already touched. */
  hasAnyDecisionFor(folderId: string, sourceCluster: string): boolean {
    const row = this.db
      .prepare<[string, string], { n: number }>(
        `SELECT 1 AS n FROM mo_topic_decisions
          WHERE folder_id = ? AND source_cluster = ? LIMIT 1`,
      )
      .get(folderId, sourceCluster);
    return !!row;
  }

  listForFolder(folderId: string): TopicDecisionRow[] {
    return this.db
      .prepare<[string], Row>(
        `SELECT * FROM mo_topic_decisions
          WHERE folder_id = ?
          ORDER BY decided_at DESC`,
      )
      .all(folderId)
      .map(rowTo);
  }

  /** Forget a decision so the hygiene job is free to re-propose the
   *  pair. `targetCluster=null` deletes the demote-tag row. */
  forget(
    folderId: string,
    sourceCluster: string,
    targetCluster: string | null,
  ): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM mo_topic_decisions
          WHERE folder_id = ? AND source_cluster = ? AND target_cluster = ?`,
      )
      .run(folderId, sourceCluster, targetCluster ?? '');
    return result.changes > 0;
  }
}

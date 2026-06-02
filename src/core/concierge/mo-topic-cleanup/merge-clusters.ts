import type Database from 'better-sqlite3';
import { CONCIERGE_ACTOR } from '../types.js';
import type { NoteMoClustersRepository } from '../mo-clusters-repository.js';
import type { MoClusterQueueRepository } from '../mo-queue-repository.js';
import type {
  MoTopicDecisionsRepository,
  TopicDecisionAuthor,
} from '../mo-topic-decisions-repository.js';
import { findClusterNoteId } from '../mo-tier2.js';

/**
 * Mo Indexing — cluster merge mechanics. Cohesive transactional state
 * machine: kept as a single file per CLAUDE.md's "domain module"
 * exception to the 500-LOC cap. Per-folder isolation throughout
 * (Case 26). Shared `MergeClustersDeps` / `MergeClustersOptions` /
 * result types live here because every sibling re-uses them.
 */

export interface MergeClustersDeps {
  db: Database.Database;
  clusters: NoteMoClustersRepository;
  clusterQueue: MoClusterQueueRepository;
  decisions: MoTopicDecisionsRepository;
}

export interface MergeClustersOptions {
  /** Free-text reason to record on the decision row + audit payload
   *  (e.g. "auto: 0.94 confidence", "user via Ask Mo"). */
  reason?: string;
  /** 'auto' = applied without asking; 'user' = user explicitly
   *  resolved an Ask Mo edge-case. */
  decidedBy?: TopicDecisionAuthor;
  now?: number;
}

export interface MergeClustersResult {
  status: 'merged' | 'noop_no_assignments' | 'noop_user_protected' | 'noop_already_decided';
  /** Note ids whose cluster set changed (had source -> now have target
   *  with at least the source's confidence). Empty when status != 'merged'. */
  affectedNoteIds: string[];
  /** Soft-deleted source-cluster note id, if one existed. */
  removedClusterNoteId: string | null;
  /** Reassignments that were skipped because the user pinned the
   *  source assignment via `source='user'` (chip dropdown). */
  preservedUserAssignmentIds: string[];
  reason: string | null;
}

interface AssignmentRow {
  note_id: string;
  confidence: number;
  source: string;
}

/**
 * Merge cluster `sourceClusterId` into `targetClusterId` inside one
 * folder. Steps in a single SQLite transaction:
 *   1. Look up source assignments scoped to this folder via JOIN.
 *   2. For each, UPSERT into target with max(existing, source)
 *      confidence. The repo's `(note_id, cluster_id)` PK + ON CONFLICT
 *      handles dedup naturally.
 *   3. Delete every source assignment for this folder.
 *   4. Soft-delete the `mo:cluster:<source>` aggregator note (set
 *      `deleted_at`) so an "undo merge" path can restore it later.
 *      Cross-folder collision: the source slug might also live in
 *      another folder; `findClusterNoteId` is folder-scoped already.
 *   5. Audit log row with the full payload (source, target, affected
 *      note ids, decided_by, reason).
 *   6. `clusterQueue.enqueue(folderId, targetClusterId)` so Tier 2
 *      regenerates target's body on its next pass — pulls in the
 *      newly-arrived notes' summaries.
 *   7. Record the decision so the hygiene job never re-proposes.
 *
 * Pinned assignments (`source='user'`) are PRESERVED on the source
 * cluster — the user explicitly put that note there, the cleanup job
 * has no business overriding. They show up in
 * `preservedUserAssignmentIds`. The merge still proceeds for every
 * other note on the source cluster; the source slug just won't be
 * fully "empty" afterwards.
 *
 * Idempotent: a second call after success is a no-op
 * ('noop_no_assignments').
 */
export function mergeClusters(
  deps: MergeClustersDeps,
  folderId: string,
  sourceClusterId: string,
  targetClusterId: string,
  options: MergeClustersOptions = {},
): MergeClustersResult {
  if (sourceClusterId === targetClusterId) {
    return {
      status: 'noop_no_assignments',
      affectedNoteIds: [],
      removedClusterNoteId: null,
      preservedUserAssignmentIds: [],
      reason: 'source equals target',
    };
  }

  // Has the user already said `kept_separate` for this exact pair?
  // The hygiene proposer should filter these out, but defence-in-depth
  // here protects manual API callers and resolves race conditions.
  const prior = deps.decisions.get(folderId, sourceClusterId, targetClusterId);
  if (prior && prior.decision === 'kept_separate') {
    return {
      status: 'noop_already_decided',
      affectedNoteIds: [],
      removedClusterNoteId: null,
      preservedUserAssignmentIds: [],
      reason: `user previously decided to keep "${sourceClusterId}" separate from "${targetClusterId}"`,
    };
  }

  const now = options.now ?? Date.now();
  const decidedBy: TopicDecisionAuthor = options.decidedBy ?? 'auto';

  // Pull source assignments scoped to this folder. JOIN with notes
  // (alive + in this folder) so we never touch cross-folder rows.
  const sourceRows = deps.db
    .prepare<[string, string], AssignmentRow>(
      `SELECT nmc.note_id, nmc.confidence, nmc.source
         FROM note_mo_clusters nmc
         JOIN notes n ON n.id = nmc.note_id
        WHERE nmc.cluster_id = ?
          AND n.folder_id = ?
          AND n.deleted_at IS NULL
          AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')`,
    )
    .all(sourceClusterId, folderId);

  if (sourceRows.length === 0) {
    return {
      status: 'noop_no_assignments',
      affectedNoteIds: [],
      removedClusterNoteId: null,
      preservedUserAssignmentIds: [],
      reason: `cluster "${sourceClusterId}" has no assignments in folder ${folderId}`,
    };
  }

  // Split into reassignable (everything except user-pinned) and
  // preserved (user-pinned stays put on the source).
  const reassignable = sourceRows.filter((r) => r.source !== 'user');
  const preserved = sourceRows.filter((r) => r.source === 'user');

  // If EVERY source assignment is user-pinned, the merge is a no-op
  // and we record `kept_separate` to stop re-proposals.
  if (reassignable.length === 0) {
    deps.decisions.record({
      folderId,
      sourceCluster: sourceClusterId,
      targetCluster: targetClusterId,
      decision: 'kept_separate',
      decidedBy: 'auto',
      decidedAt: now,
      reason: 'all source assignments are user-pinned (source=user)',
    });
    return {
      status: 'noop_user_protected',
      affectedNoteIds: [],
      removedClusterNoteId: null,
      preservedUserAssignmentIds: preserved.map((r) => r.note_id),
      reason: 'all source assignments are user-pinned',
    };
  }

  // Look up existing target rows for the affected notes so we can
  // pick max(confidence) per pair.
  const reassignableIds = reassignable.map((r) => r.note_id);
  const placeholders = reassignableIds.map(() => '?').join(',');
  const existingTargetRows = deps.db
    .prepare<string[], { note_id: string; confidence: number; source: string }>(
      `SELECT note_id, confidence, source
         FROM note_mo_clusters
        WHERE cluster_id = ?
          AND note_id IN (${placeholders})`,
    )
    .all(targetClusterId, ...reassignableIds);
  const existingTargetByNote = new Map(
    existingTargetRows.map((r) => [r.note_id, r] as const),
  );

  const removedClusterNoteId = findClusterNoteId(deps.db, folderId, sourceClusterId);

  const tx = deps.db.transaction(() => {
    // 2. UPSERT each into target with max(confidence). Source for the
    //    target row stays 'user' if the user had already pinned the
    //    target; otherwise we widen to 'verified' to mark "Mo merged
    //    into this cluster" (cheaper than making up a new source enum
    //    for "merged-from"; closest existing meaning is "Tier 1
    //    proposed and a stronger pass confirmed").
    for (const r of reassignable) {
      const existing = existingTargetByNote.get(r.note_id);
      const finalConfidence = existing
        ? Math.max(existing.confidence, r.confidence)
        : r.confidence;
      const finalSource = existing?.source === 'user' ? 'user' : 'verified';
      deps.clusters.upsert(
        {
          noteId: r.note_id,
          clusterId: targetClusterId,
          confidence: finalConfidence,
          source: finalSource as 'user' | 'verified',
        },
        now,
      );
    }

    // 3. Delete the reassignable source rows. Preserved (user-pinned)
    //    rows STAY — the user explicitly put that note on the source
    //    cluster, we don't override.
    for (const r of reassignable) {
      deps.clusters.remove(r.note_id, sourceClusterId);
    }

    // 4. Soft-delete the source aggregator note. Skip if it doesn't
    //    exist (cluster only had assignments, no doc was generated).
    //    Skip ALSO if any user-pinned rows remain — the cluster still
    //    has notes attached, so the doc shouldn't disappear.
    if (removedClusterNoteId && preserved.length === 0) {
      deps.db
        .prepare(
          `UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(now, removedClusterNoteId);
      deps.db
        .prepare(
          `INSERT INTO audit_log (note_id, action, actor, ts) VALUES (?, ?, ?, ?)`,
        )
        .run(removedClusterNoteId, 'delete', CONCIERGE_ACTOR, now);
    }

    // 5. Audit row for the merge itself. Attach payload as JSON in
    //    the action string — audit_log doesn't have a dedicated
    //    payload column, but downstream tooling parses on prefix.
    const payload = JSON.stringify({
      kind: 'cluster_merge',
      folderId,
      source: sourceClusterId,
      target: targetClusterId,
      affectedNoteIds: reassignable.map((r) => r.note_id),
      preservedUserAssignmentIds: preserved.map((r) => r.note_id),
      decidedBy,
      reason: options.reason ?? '',
    });
    // Use the target cluster note (or source's if target doesn't have
    // one yet) as the audit_log.note_id anchor — every audit row needs
    // one. We pick target so the activity feed of the target cluster
    // shows the inbound merge.
    const anchorNoteId =
      findClusterNoteId(deps.db, folderId, targetClusterId) ??
      removedClusterNoteId;
    if (anchorNoteId) {
      deps.db
        .prepare(
          `INSERT INTO audit_log (note_id, action, actor, ts)
           VALUES (?, ?, ?, ?)`,
        )
        .run(anchorNoteId, `mo:topic_cleanup ${payload}`, CONCIERGE_ACTOR, now);
    }

    // 6. Mark target cluster dirty so Tier 2 regenerates body B
    //    on its next pass with the newly-arrived notes.
    deps.clusterQueue.enqueue(folderId, targetClusterId, now);

    // 6b. If user-pinned rows kept the source cluster alive, its
    //     aggregator doc still references the notes we just moved to
    //     target. Enqueue the source for Tier 2 too so its body
    //     reflects the trimmed user-pinned set on the next pass
    //     (Codex finding 2026-05-03). Skipped when the source doc was
    //     soft-deleted in step 4 — nothing to refresh.
    if (preserved.length > 0) {
      deps.clusterQueue.enqueue(folderId, sourceClusterId, now);
    }

    // 7. Record the decision (overwrites any prior 'kept_separate').
    deps.decisions.record({
      folderId,
      sourceCluster: sourceClusterId,
      targetCluster: targetClusterId,
      decision: 'merged',
      decidedBy,
      decidedAt: now,
      reason: options.reason ?? '',
    });
  });
  tx();

  return {
    status: 'merged',
    affectedNoteIds: reassignable.map((r) => r.note_id),
    removedClusterNoteId: preserved.length === 0 ? removedClusterNoteId : null,
    preservedUserAssignmentIds: preserved.map((r) => r.note_id),
    reason: options.reason ?? null,
  };
}

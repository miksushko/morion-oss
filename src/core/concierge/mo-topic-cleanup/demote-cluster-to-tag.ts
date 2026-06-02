import type {
  MergeClustersDeps,
  MergeClustersOptions,
  MergeClustersResult,
} from './merge-clusters.js';

/**
 * Demote a generic-category cluster (e.g. `user-interface`) to a note
 * tag. The cluster's assignments become note tags on the same notes;
 * the cluster's `note_mo_clusters` rows + `mo:cluster:<id>` doc are
 * removed.
 *
 * `tagName` is the slug to use for the tag — typically a normalised
 * form of `sourceClusterId` (`user-interface` → `ui`). The proposer
 * decides the mapping; this function just executes.
 *
 * Same protection as merge: user-pinned assignments stay; full-pin
 * folder is a no-op recorded as 'kept_separate' so we don't re-loop.
 *
 * (Stub for now — full tag-write wiring lives in commit 3.2 once the
 * proposer needs it. Module structure is here to keep the engine
 * surface small.)
 */
export function demoteClusterToTag(
  deps: MergeClustersDeps,
  folderId: string,
  sourceClusterId: string,
  tagName: string,
  options: MergeClustersOptions = {},
): MergeClustersResult {
  // Intentional placeholder: returning noop_no_assignments + recording
  // the decision lets callers wire the API surface end-to-end while
  // the actual tag-write path is being implemented in the next sub-
  // commit. The proposer in 3.2 will switch to a real implementation
  // before any hygiene tick can call this in production.
  void tagName;
  const now = options.now ?? Date.now();
  deps.decisions.record({
    folderId,
    sourceCluster: sourceClusterId,
    targetCluster: null,
    decision: 'demote_tag',
    decidedBy: options.decidedBy ?? 'auto',
    decidedAt: now,
    reason: options.reason ?? `(stub) demote to tag "${tagName}"`,
  });
  return {
    status: 'noop_no_assignments',
    affectedNoteIds: [],
    removedClusterNoteId: null,
    preservedUserAssignmentIds: [],
    reason: 'demoteClusterToTag is a stub — tag-write path lands in 3.2',
  };
}

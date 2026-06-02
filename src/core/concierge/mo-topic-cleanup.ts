/**
 * Mo Indexing — topic cleanup mechanics.
 *
 * Composition barrel — all logic lives in `./mo-topic-cleanup/`:
 *   - `merge-clusters.ts`        owns `mergeClusters` + shared types.
 *   - `demote-cluster-to-tag.ts` owns the demote-to-tag stub.
 *   - `apply-quick-action.ts`    dispatches Ask-Mo quick-action
 *                                payloads to the two operations above.
 *
 * Per the 2026-05-16 split (Morion ticket 01KRQYVFE7C4XWV6A6N36YQX0Z),
 * importers should keep using the package path
 * `src/core/concierge/mo-topic-cleanup.js` — this barrel preserves the
 * pre-split public surface verbatim.
 */
export {
  mergeClusters,
  type MergeClustersDeps,
  type MergeClustersOptions,
  type MergeClustersResult,
} from './mo-topic-cleanup/merge-clusters.js';
export { demoteClusterToTag } from './mo-topic-cleanup/demote-cluster-to-tag.js';
export {
  applyCleanupQuickAction,
  type CleanupDecisionReceipt,
} from './mo-topic-cleanup/apply-quick-action.js';

import { mergeClusters, type MergeClustersDeps } from './merge-clusters.js';
import { demoteClusterToTag } from './demote-cluster-to-tag.js';

/**
 * Apply a user-resolved cleanup decision delivered via a quick-action
 * button click in Ask Mo. Single dispatch entry-point so the route
 * doesn't sprout per-kind branches; `payload.kind` discriminates.
 *
 * Payload shapes (mirror what `maybeOpenEscalationChat` emits):
 *   - `cleanup-merge`  {folderId, source, target}    -> mergeClusters
 *   - `cleanup-demote` {folderId, source, suggestedTag} -> demoteClusterToTag
 *   - `cleanup-keep`   {folderId, source, target}    -> records kept_separate
 *
 * Returns a normalised receipt the route hands back to the UI so the
 * client can confirm what landed (e.g. show "Merged 3 notes into
 * `auto-code`" inline under the button).
 */
export interface CleanupDecisionReceipt {
  decision: 'merged' | 'kept_separate' | 'demote_tag';
  source: string;
  target: string | null;
  affectedNoteIds?: string[];
  /** Human-readable one-liner the UI shows next to the disabled button. */
  summary: string;
}

export function applyCleanupQuickAction(
  deps: MergeClustersDeps,
  payload: Record<string, unknown>,
  now: number = Date.now(),
): CleanupDecisionReceipt {
  const kind = String(payload.kind ?? '');
  const folderId = String(payload.folderId ?? '');

  // Bundle paths: payload carries `topics[]` (the whole group) +
  // `target` (chosen main) for merge-bundle, or just `topics[]` for
  // keep-bundle. They don't have a single `source`, so the missing-
  // field check below is bypassed for bundle kinds.
  if (kind === 'cleanup-bundle-merge') {
    const target = String(payload.target ?? '');
    const topicsRaw = payload.topics;
    if (!folderId || !target || !Array.isArray(topicsRaw) || topicsRaw.length < 2) {
      throw new Error(
        'applyCleanupQuickAction: cleanup-bundle-merge requires folderId, target, topics[≥2]',
      );
    }
    const topics = topicsRaw.filter((t): t is string => typeof t === 'string');
    const sources = topics.filter((t) => t !== target);
    let totalAffected = 0;
    for (const src of sources) {
      const result = mergeClusters(deps, folderId, src, target, {
        decidedBy: 'user',
        reason: `user bundle-merge via Ask Mo (bundle target ${target})`,
        now,
      });
      if (result.status === 'merged') totalAffected += result.affectedNoteIds.length;
    }
    return {
      decision: 'merged',
      source: sources.join(','),
      target,
      affectedNoteIds: [],
      summary: `Merged ${sources.length} topic${sources.length === 1 ? '' : 's'} into \`${target}\` (${totalAffected} note${totalAffected === 1 ? '' : 's'} reassigned)`,
    };
  }

  if (kind === 'cleanup-bundle-keep') {
    const topicsRaw = payload.topics;
    if (!folderId || !Array.isArray(topicsRaw) || topicsRaw.length < 2) {
      throw new Error(
        'applyCleanupQuickAction: cleanup-bundle-keep requires folderId + topics[≥2]',
      );
    }
    const topics = topicsRaw.filter((t): t is string => typeof t === 'string');
    // Record kept_separate for every ordered pair so future hygiene
    // passes don't re-propose. (Pairs are directional in
    // mo_topic_decisions; we record both directions.)
    let pairsRecorded = 0;
    for (const a of topics) {
      for (const b of topics) {
        if (a === b) continue;
        deps.decisions.record({
          folderId,
          sourceCluster: a,
          targetCluster: b,
          decision: 'kept_separate',
          decidedBy: 'user',
          decidedAt: now,
          reason: 'user bundle-keep-all via Ask Mo',
        });
        pairsRecorded++;
      }
    }
    return {
      decision: 'kept_separate',
      source: topics.join(','),
      target: null,
      summary: `Kept all ${topics.length} topics separate (${pairsRecorded} pair decision${pairsRecorded === 1 ? '' : 's'} recorded)`,
    };
  }

  // Per-pair / per-demote paths from here on require source.
  const source = String(payload.source ?? '');
  if (!folderId || !source) {
    throw new Error(
      `applyCleanupQuickAction: payload missing folderId/source (kind=${kind})`,
    );
  }

  if (kind === 'cleanup-merge') {
    const target = String(payload.target ?? '');
    if (!target) {
      throw new Error('applyCleanupQuickAction: cleanup-merge requires target');
    }
    const result = mergeClusters(deps, folderId, source, target, {
      decidedBy: 'user',
      reason: 'user via Ask Mo quick-action',
      now,
    });
    return {
      decision: 'merged',
      source,
      target,
      affectedNoteIds: result.affectedNoteIds,
      summary:
        result.status === 'merged'
          ? `Merged ${result.affectedNoteIds.length} note${result.affectedNoteIds.length === 1 ? '' : 's'} into \`${target}\``
          : result.status === 'noop_user_protected'
          ? `Kept separate — all source assignments are user-pinned`
          : result.status === 'noop_already_decided'
          ? `Already decided previously`
          : `No assignments to move`,
    };
  }

  if (kind === 'cleanup-demote') {
    const suggestedTag = String(payload.suggestedTag ?? '');
    if (!suggestedTag) {
      throw new Error(
        'applyCleanupQuickAction: cleanup-demote requires suggestedTag',
      );
    }
    demoteClusterToTag(deps, folderId, source, suggestedTag, {
      decidedBy: 'user',
      reason: 'user via Ask Mo quick-action',
      now,
    });
    return {
      decision: 'demote_tag',
      source,
      target: null,
      summary: `Recorded demote of \`${source}\` to tag \`${suggestedTag}\` (tag-write path lands later)`,
    };
  }

  if (kind === 'cleanup-keep') {
    const targetRaw = payload.target;
    const target = typeof targetRaw === 'string' && targetRaw.length > 0
      ? targetRaw
      : null;
    deps.decisions.record({
      folderId,
      sourceCluster: source,
      targetCluster: target,
      decision: 'kept_separate',
      decidedBy: 'user',
      decidedAt: now,
      reason: 'user via Ask Mo quick-action',
    });
    return {
      decision: 'kept_separate',
      source,
      target,
      summary: target
        ? `Will keep \`${source}\` and \`${target}\` separate`
        : `Will keep \`${source}\` as a topic (no demote)`,
    };
  }

  throw new Error(`applyCleanupQuickAction: unknown payload.kind ${kind}`);
}

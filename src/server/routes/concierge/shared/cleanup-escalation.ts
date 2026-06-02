/**
 * Detect a custom-instruction reply to a pending topic-cleanup escalation
 * + build the context block for `buildChatSystemPrompt`. Extracted from
 * `../shared.ts` (2026-05-16, ticket `01KRQYS1T925XEWBBJJYRJBGE2`).
 */

import {
  type ConciergeMessage,
  type CleanupEscalationContext,
  type CleanupEscalationDecision,
} from '../../../../core/concierge/index.js';

/**
 * Detect whether the latest user message is a custom-instruction reply
 * to a pending topic-cleanup escalation, and if so build the context
 * block for `buildChatSystemPrompt`.
 *
 * Trigger: the most-recent user row has `repliedActionId` of shape
 * `(bundle|demote):<idx>:custom`. That id is set by the front-end's
 * inline "Give different instruction" editor — see `QuickActionGroups`
 * and the "POSTs through standard /messages route with phantom
 * <group>:custom repliedActionId" rule in CLAUDE.md.
 *
 * When matched, we walk back to find the assistant message that owns
 * that group key (its `quickActions` carry payloads with
 * `kind: 'cleanup-bundle-merge' | 'cleanup-bundle-keep' | 'cleanup-demote'
 *  | 'cleanup-keep'`) and extract the proposer's structured choices.
 *
 * Returns null in every other case — null lets the system prompt fall
 * through to plain chat behaviour.
 */
export function detectCleanupEscalationContext(
  history: ConciergeMessage[],
  folderName: string | null,
): CleanupEscalationContext | null {
  // Walk backwards for the most-recent user row. Skip tool / assistant
  // / system rows so a stray earlier user message can't shadow it.
  let userMsg: ConciergeMessage | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === 'user') {
      userMsg = m;
      break;
    }
  }
  if (!userMsg || !userMsg.repliedActionId) return null;
  const groupMatch = userMsg.repliedActionId.match(
    /^(bundle|demote):(\d+):custom$/,
  );
  if (!groupMatch) return null;
  const groupPrefix = `${groupMatch[1]}:${groupMatch[2]}:`;

  // Find the assistant message whose quickActions own this group.
  // Scan backwards from the user row for the closest assistant with
  // matching ids — multiple cleanup escalations across one session
  // would otherwise blur together.
  let proposalMsg: ConciergeMessage | null = null;
  for (let i = history.indexOf(userMsg) - 1; i >= 0; i--) {
    const m = history[i]!;
    if (
      m.role === 'assistant' &&
      m.quickActions &&
      m.quickActions.some((a) => a.id.startsWith(groupPrefix))
    ) {
      proposalMsg = m;
      break;
    }
  }
  if (!proposalMsg || !proposalMsg.quickActions) return null;

  const decisions: CleanupEscalationDecision[] = [];
  // Group-scoped extraction: only pull the actions whose ids share the
  // group prefix. The proposer can stack multiple bundles + demotes in
  // one message; the user's reply targets exactly one group.
  const groupActions = proposalMsg.quickActions.filter((a) =>
    a.id.startsWith(groupPrefix),
  );

  // Bundle path — collect topics + recommendedMain. The "recommended"
  // marker is in the label string (suffix `(recommended)`), so we
  // pick the bundle-merge payload with the matching `target` flag.
  const bundleMerges = groupActions.filter(
    (a) =>
      typeof a.payload === 'object' &&
      a.payload !== null &&
      (a.payload as { kind?: unknown }).kind === 'cleanup-bundle-merge',
  );
  if (bundleMerges.length > 0) {
    const first = bundleMerges[0]!.payload as {
      topics?: unknown;
      target?: unknown;
    };
    const topics = Array.isArray(first.topics)
      ? (first.topics as unknown[]).filter(
          (t): t is string => typeof t === 'string',
        )
      : [];
    // Recommended main = the action whose label contains
    // "(recommended)". Falls back to the first bundle-merge target.
    const recommendedAction = bundleMerges.find((a) =>
      a.label.includes('(recommended)'),
    );
    const recommendedMain =
      recommendedAction &&
      typeof (recommendedAction.payload as { target?: unknown }).target ===
        'string'
        ? ((recommendedAction.payload as { target: string }).target)
        : typeof first.target === 'string'
          ? first.target
          : topics[0] ?? '';
    if (topics.length > 0 && recommendedMain) {
      decisions.push({ kind: 'merge-bundle', topics, recommendedMain });
    }
  } else {
    // Demote path — single payload per group with `source` + `suggestedTag`.
    const demote = groupActions.find(
      (a) =>
        typeof a.payload === 'object' &&
        a.payload !== null &&
        (a.payload as { kind?: unknown }).kind === 'cleanup-demote',
    );
    if (demote) {
      const p = demote.payload as { source?: unknown; suggestedTag?: unknown };
      if (typeof p.source === 'string' && typeof p.suggestedTag === 'string') {
        decisions.push({
          kind: 'demote',
          source: p.source,
          suggestedTag: p.suggestedTag,
        });
      }
    }
  }

  if (decisions.length === 0) return null;
  return { folderName, decisions };
}

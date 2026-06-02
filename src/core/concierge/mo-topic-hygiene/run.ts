import type { LLMRequest } from '../provider.js';
import { completeWithFallback } from '../provider.js';
import { spendInputFromLLMResponse } from '../mo-spend-ledger.js';
import { mergeClusters, demoteClusterToTag } from '../mo-topic-cleanup.js';
import {
  TOPIC_HYGIENE_AUTO_THRESHOLD,
  TOPIC_HYGIENE_MIN_CLUSTERS,
  type HygieneMergeProposal,
  type HygieneDemoteProposal,
  type RunTopicHygieneDeps,
  type RunTopicHygieneOptions,
  type RunTopicHygieneResult,
} from './types.js';
import { gatherClusterPanorama } from './panorama.js';
import { buildHygieneMessages, parseHygieneResponse } from './prompt.js';
import { filterAgainstDecisions, decisionsBlockedHint } from './decisions.js';
import { maybeOpenEscalationChat } from './escalation.js';

/**
 * Run one topic-hygiene pass for a folder.
 *
 * Pipeline: panorama → blocked-pair hint → LLM call → parse →
 * filter against decisions → drop hallucinated cluster ids → auto-
 * apply high-confidence merges/demotes → escalate the rest to a
 * single Ask Mo session.
 *
 * Hard contracts (mirrored from the shell module doc):
 * - Decisions in `mo_topic_decisions` are FINAL. Pairs that already
 *   have a decision are filtered both pre- and post-LLM.
 * - Auto-apply only when confidence >= AUTO_THRESHOLD.
 * - One Ask Mo session per run accumulates ALL edge cases.
 * - Folder-scoped throughout; budget-gated.
 */
export async function runTopicHygiene(
  deps: RunTopicHygieneDeps,
  folderId: string,
  options: RunTopicHygieneOptions = {},
): Promise<RunTopicHygieneResult> {
  const now = options.now ?? Date.now();
  const autoThreshold = options.autoThreshold ?? TOPIC_HYGIENE_AUTO_THRESHOLD;

  const panorama = gatherClusterPanorama(deps.db, folderId);
  if (panorama.length < TOPIC_HYGIENE_MIN_CLUSTERS) {
    return { status: 'skipped', reason: 'too_few_clusters' };
  }

  if (deps.budget && !deps.budget.status(now).withinBudget) {
    return { status: 'skipped', reason: 'budget_exhausted' };
  }

  const blockedHint = decisionsBlockedHint(deps.decisions, folderId, 200);

  const messages = buildHygieneMessages(
    panorama,
    options.topicExclusions ?? '',
    blockedHint,
  );
  const req: LLMRequest = {
    model: deps.model,
    messages,
    temperature: 0.1,
  };

  let response;
  try {
    response = await completeWithFallback(deps.provider, req, deps.fallbackModel);
  } catch (err) {
    return {
      status: 'error',
      reason: 'provider_failed',
      message: (err as Error).message ?? 'provider call failed',
    };
  }

  const proposal = parseHygieneResponse(response.content ?? '');
  if (!proposal) {
    if (deps.budget && response.costUsd > 0) {
      deps.budget.record(spendInputFromLLMResponse({ kind: 'mo_topic_hygiene' }, response), now);
    }
    return {
      status: 'skipped',
      reason: 'invalid_response',
      message: `proposer returned unparseable response (${(response.content ?? '').slice(0, 100)}…)`,
    };
  }

  if (deps.budget && response.costUsd > 0) {
    deps.budget.record(spendInputFromLLMResponse({ kind: 'mo_topic_hygiene' }, response), now);
  }

  const { merges, demotes, blocked } = filterAgainstDecisions(
    proposal,
    deps.decisions,
    folderId,
  );

  // Validate against the actual panorama — proposer may hallucinate
  // cluster ids that don't exist. Drop those.
  const liveIds = new Set(panorama.map((p) => p.clusterId));
  const validMerges = merges.filter(
    (m) => liveIds.has(m.source) && liveIds.has(m.target),
  );
  const validDemotes = demotes.filter((d) => liveIds.has(d.source));

  const cleanupDeps = {
    db: deps.db,
    clusters: deps.clusters,
    clusterQueue: deps.clusterQueue,
    decisions: deps.decisions,
  };

  const autoMerged: HygieneMergeProposal[] = [];
  const autoDemoted: HygieneDemoteProposal[] = [];
  const escalatedToChat: Array<HygieneMergeProposal | HygieneDemoteProposal> = [];

  for (const m of validMerges) {
    if (m.confidence >= autoThreshold) {
      const result = mergeClusters(cleanupDeps, folderId, m.source, m.target, {
        decidedBy: 'auto',
        reason: `auto: ${m.confidence.toFixed(2)} — ${m.reason}`,
        now,
      });
      if (result.status === 'merged') {
        autoMerged.push(m);
      }
      // Other statuses (already_decided / no_assignments / user_protected)
      // already record the decision themselves; nothing extra to do.
    } else {
      escalatedToChat.push(m);
    }
  }

  for (const d of validDemotes) {
    if (d.confidence >= autoThreshold) {
      demoteClusterToTag(cleanupDeps, folderId, d.source, d.suggestedTag, {
        decidedBy: 'auto',
        reason: `auto: ${d.confidence.toFixed(2)} — ${d.reason}`,
        now,
      });
      autoDemoted.push(d);
    } else {
      escalatedToChat.push(d);
    }
  }

  const escalationSessionId = await maybeOpenEscalationChat(
    deps,
    folderId,
    escalatedToChat,
    proposal.summary,
    now,
  );

  return {
    status: 'ok',
    panoramaSize: panorama.length,
    considered: validMerges.length + validDemotes.length,
    autoMerged,
    autoDemoted,
    escalatedToChat,
    blockedByDecision: blocked,
    summary: proposal.summary,
    escalationSessionId,
    costUsd: response.costUsd ?? 0,
  };
}

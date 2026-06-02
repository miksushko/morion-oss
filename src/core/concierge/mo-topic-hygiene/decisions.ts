import type { MoTopicDecisionsRepository } from '../mo-topic-decisions-repository.js';
import type {
  HygieneProposal,
  HygieneMergeProposal,
  HygieneDemoteProposal,
} from './types.js';

/** Filter proposals against existing decisions. Pure — no DB writes. */
export function filterAgainstDecisions(
  proposal: HygieneProposal,
  decisions: MoTopicDecisionsRepository,
  folderId: string,
): {
  merges: HygieneMergeProposal[];
  demotes: HygieneDemoteProposal[];
  blocked: Array<{ source: string; target: string | null }>;
} {
  const blocked: Array<{ source: string; target: string | null }> = [];
  const merges = proposal.merges.filter((m) => {
    const prior = decisions.get(folderId, m.source, m.target);
    if (prior) {
      blocked.push({ source: m.source, target: m.target });
      return false;
    }
    return true;
  });
  const demotes = proposal.demotes.filter((d) => {
    const prior = decisions.get(folderId, d.source, null);
    if (prior) {
      blocked.push({ source: d.source, target: null });
      return false;
    }
    return true;
  });
  return { merges, demotes, blocked };
}

/** Build the blocked-pairs hint from prior decisions so the proposer
 *  doesn't waste tokens re-proposing them. Cap at `cap` entries to
 *  keep the prompt size bounded — beyond that the proposer can
 *  re-propose and we filter post-hoc. */
export function decisionsBlockedHint(
  decisions: MoTopicDecisionsRepository,
  folderId: string,
  cap: number,
): Array<{ source: string; target: string | null }> {
  const all = decisions.listForFolder(folderId);
  return all.slice(0, cap).map((d) => ({
    source: d.sourceCluster,
    target: d.targetCluster,
  }));
}

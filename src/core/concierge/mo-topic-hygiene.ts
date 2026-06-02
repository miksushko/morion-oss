/**
 * Mo Indexing — periodic topic-hygiene proposer.
 *
 * Reads the current cluster panorama for ONE folder, asks a stronger
 * LLM (`topicHygieneModel`) to propose merge pairs + demote-to-tag
 * candidates, then either auto-applies (high confidence) or opens a
 * single Ask Mo session for the user to resolve edge cases.
 *
 * Why a separate proposer (vs. just letting Tier 1's better prompt
 * prevent drift): commit 1 + commit 2 stop NEW duplicates from
 * appearing, but they don't repair the existing 376-cluster historical
 * tail on Morion Features. This worker is the one-shot recovery for
 * existing folders + a slow drip (4h cron) for any drift the prompt
 * still can't catch.
 *
 * Hard contracts:
 * - Decisions in `mo_topic_decisions` are FINAL. Any pair that already
 *   has a decision (merged / kept_separate / demote_tag) is filtered
 *   out before the LLM call so we don't burn tokens re-proposing what
 *   the user already resolved.
 * - Auto-apply only when confidence >= AUTO_THRESHOLD AND the source
 *   cluster has no user-pinned assignments (the merge mechanics in
 *   `mergeClusters` enforce the user-pin protection independently;
 *   this is just a courtesy short-circuit).
 * - One Ask Mo session per hygiene run, accumulating ALL edge cases.
 *   Spamming N sessions per pair would drown the user; one session
 *   with a numbered list is reviewable.
 * - Folder-scoped throughout (Case 26).
 * - Budget-gated via the same `BudgetTracker` Mo uses for chat /
 *   tier1 / tier2.
 *
 * This file is a barrel only — see the sibling modules for code:
 *   types.ts       constants + public interfaces
 *   panorama.ts    gatherClusterPanorama (SQL)
 *   prompt.ts      buildHygieneMessages + parseHygieneResponse
 *   bundle.ts      bundleMergeProposals (union-find)
 *   decisions.ts   filterAgainstDecisions + decisionsBlockedHint
 *   escalation.ts  maybeOpenEscalationChat (Ask Mo session)
 *   run.ts         runTopicHygiene (per-folder orchestrator)
 *   poll.ts        pollTopicHygieneAcrossFolders (scheduler entry)
 */

export {
  TOPIC_HYGIENE_AUTO_THRESHOLD,
  TOPIC_HYGIENE_MIN_CLUSTERS,
  TOPIC_HYGIENE_MAX_CLUSTERS,
  TOPIC_HYGIENE_LAST_RUN_KEY_PREFIX,
  TOPIC_HYGIENE_LAST_RUN_AT,
} from './mo-topic-hygiene/types.js';
export type {
  ClusterPanoramaItem,
  HygieneMergeProposal,
  HygieneDemoteProposal,
  HygieneProposal,
  RunTopicHygieneDeps,
  RunTopicHygieneOptions,
  RunTopicHygieneResult,
  MergeBundle,
} from './mo-topic-hygiene/types.js';

export { gatherClusterPanorama } from './mo-topic-hygiene/panorama.js';
export { buildHygieneMessages, parseHygieneResponse } from './mo-topic-hygiene/prompt.js';
export { bundleMergeProposals } from './mo-topic-hygiene/bundle.js';
export { filterAgainstDecisions } from './mo-topic-hygiene/decisions.js';
export { runTopicHygiene } from './mo-topic-hygiene/run.js';
export {
  pollTopicHygieneAcrossFolders,
  type TopicHygienePollDeps,
  type TopicHygienePollSummary,
} from './mo-topic-hygiene/poll.js';

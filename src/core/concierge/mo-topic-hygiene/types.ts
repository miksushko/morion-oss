import type Database from 'better-sqlite3';
import type { LLMProvider } from '../provider.js';
import type { BudgetTracker } from '../budget.js';
import type { NoteMoClustersRepository } from '../mo-clusters-repository.js';
import type { MoClusterQueueRepository } from '../mo-queue-repository.js';
import type { MoTopicDecisionsRepository } from '../mo-topic-decisions-repository.js';
import type { ConciergeSessionsRepository } from '../sessions-repository.js';
import type { ConciergeMessagesRepository } from '../messages-repository.js';

export const TOPIC_HYGIENE_AUTO_THRESHOLD = 0.8;
export const TOPIC_HYGIENE_MIN_CLUSTERS = 3;
export const TOPIC_HYGIENE_MAX_CLUSTERS = 500;
export const TOPIC_HYGIENE_LAST_RUN_KEY_PREFIX = 'mo.topic_hygiene.last_run.';
export const TOPIC_HYGIENE_LAST_RUN_AT = (folderId: string): string =>
  `${TOPIC_HYGIENE_LAST_RUN_KEY_PREFIX}${folderId}`;

export interface ClusterPanoramaItem {
  clusterId: string;
  noteCount: number;
  /** Up to 5 most-recently-updated note titles, for the proposer to
   *  judge what each cluster is actually about. */
  sampleTitles: string[];
  /** Has at least one assignment with `source='user'` — proposer is
   *  told these are pinned and merging them is a no-op. */
  hasUserPin: boolean;
}

export interface HygieneMergeProposal {
  source: string;
  target: string;
  confidence: number;
  reason: string;
}

export interface HygieneDemoteProposal {
  source: string;
  suggestedTag: string;
  confidence: number;
  reason: string;
}

export interface HygieneProposal {
  merges: HygieneMergeProposal[];
  demotes: HygieneDemoteProposal[];
  /** Free-text overall summary the proposer wrote (logged, not shown
   *  to the user unless an edge case escalates). */
  summary: string;
}

export interface RunTopicHygieneDeps {
  db: Database.Database;
  clusters: NoteMoClustersRepository;
  clusterQueue: MoClusterQueueRepository;
  decisions: MoTopicDecisionsRepository;
  sessions?: ConciergeSessionsRepository;
  messages?: ConciergeMessagesRepository;
  provider: LLMProvider;
  budget?: BudgetTracker;
  model: string;
  fallbackModel: string | null;
}

export interface RunTopicHygieneOptions {
  /** Auto-apply threshold (default `TOPIC_HYGIENE_AUTO_THRESHOLD`). */
  autoThreshold?: number;
  /** Force a re-run even if the proposer's panorama looks identical
   *  to the previous run (incremental mode, future use). */
  force?: boolean;
  now?: number;
  /** Free-text generic-terms blocklist for this folder, plumbed into
   *  the prompt so the proposer biases demotes against these words. */
  topicExclusions?: string;
}

export type RunTopicHygieneResult =
  | {
      status: 'ok';
      panoramaSize: number;
      considered: number;
      autoMerged: HygieneMergeProposal[];
      autoDemoted: HygieneDemoteProposal[];
      escalatedToChat: Array<HygieneMergeProposal | HygieneDemoteProposal>;
      blockedByDecision: Array<{ source: string; target: string | null }>;
      summary: string;
      escalationSessionId: string | null;
      costUsd: number;
    }
  | {
      status: 'skipped';
      reason: 'too_few_clusters' | 'budget_exhausted' | 'invalid_response';
      message?: string;
    }
  | {
      status: 'error';
      reason: 'provider_failed';
      message: string;
    };

/**
 * A bundle of cluster topics that should be merged together. Built
 * by `bundleMergeProposals` from a list of pairwise merge proposals
 * via union-find — proposers may emit `{A→C, B→C}` which collapses
 * into one bundle `{A, B, C}` with `C` as recommended main.
 */
export interface MergeBundle {
  topics: string[];
  recommendedMain: string;
  /** The original proposals that landed in this bundle (kept for
   *  reasoning + confidence display in the UI). */
  proposals: HygieneMergeProposal[];
  /** Average proposal confidence across the bundle. */
  confidence: number;
  /** Concatenated proposer reasoning, deduplicated. */
  reasoning: string;
}

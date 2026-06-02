/**
 * Mo Indexing domain types — per-folder topic cluster surface, catalog,
 * risks, patrol log + findings, finding-acknowledge envelopes.
 */

/** One row in the per-folder Tasks Topics tab. `summary` is null for
 *  clusters Tier 1 surfaced but Tier 2 has not yet built an aggregator
 *  note for — the UI surfaces them with a placeholder. */
export interface FolderTopic {
  clusterId: string;
  noteCount: number;
  maxConfidence: number;
  /** Distinct values from the underlying note_mo_clusters rows. */
  sources: string[];
  /** True iff at least one assignment came from `mo_reclassify` /
   *  user-promoted action — distinct visual treatment in the UI. */
  userPromoted: boolean;
  /** ULID of the mo:cluster:<id> note iff Tier 2 has run; null when
   *  still suggested. */
  clusterNoteId: string | null;
  summary: string | null;
  updatedAt: number;
}

export type RegenerateTopicResult =
  | {
      folderId: string;
      clusterId: string;
      status: 'computed';
      clusterNoteId: string;
      noteCount: number;
      costUsd: number;
    }

/** Phase 6.8 — single-topic doc payload backing the editor pane
 *  inside the Tasks Topics tab. `clusterNoteId` is null when the
 *  cluster only has Tier 1 assignments and Tier 2 hasn't built the
 *  aggregator note yet — the editor still lets the user type and
 *  the PATCH route lazy-creates the note on first save. */
export interface TopicDocPayload {
  folderId: string;
  clusterId: string;
  clusterNoteId: string | null;
  body: string | null;
  sections: {
    overview: string;
    state: string;
    open: string;
    notes: string;
  } | null;
  updatedAt: number | null;
}

/** Mo Indexing — topic-cleanup engine result (POST run). */
export interface TopicCleanupMergeProposal {
  source: string;
  target: string;
  confidence: number;
  reason: string;
}

export interface TopicCleanupDemoteProposal {
  source: string;
  suggestedTag: string;
  confidence: number;
  reason: string;
}

export type TopicCleanupRunResult =
  | {
      status: 'ok';
      panoramaSize: number;
      considered: number;
      autoMerged: TopicCleanupMergeProposal[];
      autoDemoted: TopicCleanupDemoteProposal[];
      escalatedToChat: Array<TopicCleanupMergeProposal | TopicCleanupDemoteProposal>;
      blockedByDecision: Array<{ source: string; target: string | null }>;
      summary: string;
      escalationSessionId: string | null;
      costUsd: number;
    }

export interface TopicDecisionRow {
  folderId: string;
  sourceCluster: string;
  targetCluster: string | null;
  decision: 'merged' | 'kept_separate' | 'demote_tag';
  decidedBy: 'auto' | 'user';
  decidedAt: number;
  reason: string;
}

export interface TopicCleanupStatus {
  folderId: string;
  lastRunAt: number | null;
  decisions: TopicDecisionRow[];
}

/** Phase 6.7 — per-folder catalog body backing the Project Summary
 *  tab. Both `body` and `sections` are null when no Tier 2.5 has run
 *  yet (new folder, no clusters detected). When populated, `body` is
 *  the full markdown of the mo:catalog note (preserved exactly,
 *  including comment markers); `sections` is the parsed view of the
 *  four anchored regions. */
export interface FolderCatalog {
  folderId: string;
  catalogNoteId: string | null;
  body: string | null;
  sections: {
    overview: string;
    clusters: string;
    recent: string;
    risks: string;
  } | null;
  updatedAt: number | null;
}

/** Phase 6.4 — Logs tab feed: patrol-log narrative note body + the
 *  full mo_patrol_findings lifecycle (open + recently-resolved). */
export interface PatrolFinding {
  id: string;
  folderId: string;
  noteId: string | null;
  kind: string;
  severity: string;
  message: string;
  context: Record<string, unknown>;
  createdAt: number;
  state: string;
  stateChangedAt: number;
  snoozeUntil: number | null;
}

export interface FolderLogs {
  folderId: string;
  patrolLog: {
    noteId: string | null;
    body: string | null;
    updatedAt: number | null;
  };
  openFindings: PatrolFinding[];
  resolvedFindings: PatrolFinding[];
}

export type AcknowledgeFindingAction = 'accept' | 'dismiss' | 'snooze';

export interface AcknowledgeFindingInput {
  action: AcknowledgeFindingAction;
  /** Required when action='snooze'. ms-epoch when to auto-reopen. */
  snoozeUntilTs?: number;
}

export type AcknowledgeFindingResult =
  | {
      findingId: string;
      action: AcknowledgeFindingAction;
      state: string;
      snoozeUntil: number | null;
      stateChangedAt: number;
    }

/** Phase 6.3 — Project Risks tab payload. Combines the LLM-tier
 *  catalog `risks` section with deterministic Tier 0 high-severity
 *  open findings so the UI can show both in one feed. */
export interface FolderRisks {
  folderId: string;
  catalog: {
    /** ULID of the mo:catalog note iff Tier 2.5 has run for the folder. */
    noteId: string | null;
    /** Trimmed body of the catalog's `risks` anchored section, or null
     *  when no catalog exists yet / the section is still placeholder. */
    risks: string | null;
    updatedAt: number | null;
  };
  /** Open Tier 0 findings with severity 'p0' / 'p1', already filtered. */
  findings: Array<{
    id: string;
    kind: string;
    severity: string;
    message: string;
    noteId: string | null;
    context: Record<string, unknown>;
    createdAt: number;
  }>;
}

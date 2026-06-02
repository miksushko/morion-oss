/** Output shape from Wave 1 (keyword-generator + per-cluster
 *  analysts). Consumed by Wave 2 (drives body-extractor candidate
 *  selection) and by the synthesizer. */
export interface Wave1Output {
  keywords: string[];
  /** Per-cluster analyst findings, in cluster-id order. */
  clusterFindings: Array<{
    clusterId: string;
    drillIntoNoteIds: string[];
    why: string;
  }>;
  spentUsd: number;
  warnings: string[];
}

/** Output shape from Wave 2 (body-extractor on selected ids +
 *  cross-folder workspace candidates). Consumed by the synthesizer
 *  only. */
export interface Wave2Output {
  bodyExtractions: Array<{
    noteId: string;
    title: string;
    chunks: string[];
    why: string;
    isWarning: boolean;
  }>;
  workspaceCandidates: Array<{
    noteId: string;
    title: string;
    summary: string | null;
    folderId: string | null;
  }>;
  spentUsd: number;
  warnings: string[];
}

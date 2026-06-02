/**
 * Auto-Code workflow runner domain types — workflows + templates,
 * preflight, queue rows + states, in-flight summary, budget, cancel
 * summary, merge envelopes (result + prepare + apply + status + AI
 * resolve), conflict files, changed-file listings, file-content,
 * diff-stat, transcript message + payload.
 */

/** Per-folder workflow row. After Этап 6 (template seeding) the
 *  registry-shipped templates land in this list as editable
 *  rows on first folder open — there's no longer a separate
 *  "built-in" surface. Full definition is fetched separately
 *  when the editor opens. Agent availability is INTENTIONALLY
 *  not on this shape — it would force the list endpoint to
 *  shell out to `<bin> --version` per row, blocking the popup
 *  on slow probes. The orchestrator's pre-claim gate is the
 *  source of truth on availability; the UI surfaces failures
 *  on actual enqueue. */
export interface AutoCodeWorkflowSummary {
  id: string;
  folderId: string;
  name: string;
  isDefault: boolean;
  stageCount: number;
  agentChain: readonly string[];
  /** True when the workflow's definition contains v2 stage kinds the
   *  L2 linear runner can't dispatch. Sidebar swaps the "active"
   *  badge for a "preview" treatment so the user knows their edits
   *  on this row don't reach a real run until the Phase 4 DAG runner
   *  ships — the kanban route falls back to the LEGACY_LINEAR
   *  template via resolveWorkflowDefinition's miss path while the
   *  setting still points at the v2 registry id. */
  isDraft: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Full workflow row including the parsed `WorkflowDefinition`.
 *  The UI editor reads this when the user opens an existing
 *  workflow to edit. */
export interface AutoCodeWorkflowFull extends AutoCodeWorkflowSummary {
  /** WorkflowDefinition shape — the editor renders + writes raw
   *  JSON, so the type is opaque from the UI's perspective. */
  definition: unknown;
}

/** Static metadata for a shipped Auto-Code workflow template. The
 *  full definition (prompts, budgets, etc.) stays server-side; the
 *  UI only needs identity + agent chain to render the dropdown. */
export interface AutoCodeWorkflowTemplate {
  id: string;
  label: string;
  description: string;
  agentChain: readonly string[];
  /** Agents that must be installed for this template to run. */
  requiredAgents: readonly string[];
  /** Agents that participate but have a fallback (e.g. codex with
   *  claude fallback) — informational only; not gating. */
  optionalAgents: readonly string[];
  stageCount: number;
  /** True when every required agent's binary is detected on the
   *  host. The UI should `disabled` non-`available` options. */
  available: boolean;
  /** When `available=false`, a one-line explanation suitable for a
   *  tooltip ("Requires pi (not installed on this machine)."). */
  unavailableReason: string | null;
}

/** Auto-code Phase 1 — environment pre-flight check
 *  (sub-ticket 01KQEEARKNH9TE8D008WAX7PQ7). Mirrors
 *  `src/core/auto-code/preflight.ts` PreflightResult exactly. */
export interface AutoCodeBinaryStatus {
  ready: boolean;
  path: string | null;
  source: 'path' | 'vscode-extension' | 'desktop-app-vm' | null;
  error: string | null;
}

export interface AutoCodeMcpInstallStatus {
  installed: boolean;
  configPath: string;
  error: string | null;
}

export interface AutoCodePreflight {
  claude: AutoCodeBinaryStatus;
  codex: AutoCodeBinaryStatus;
  mcp: { claude: AutoCodeMcpInstallStatus; codex: AutoCodeMcpInstallStatus };
  /** Empty array = OK to enable auto-code (assuming linked repo + Mo
   *  are also configured). Non-empty entries are human-readable
   *  reasons to surface in the UI banner. */
  blocking: string[];
}

/** Workflow-resolution diagnostic — what the sidecar actually resolves
 *  the folder's stored workflow selection to. Mirrors
 *  `FolderWorkflowResolutionDiagnostic` on the server. Morion ticket
 *  01KRRXB2K744SKJGAZHW6KET93. */
export type AutoCodeWorkflowResolution = {
  storedId: string;
  resolved:
    | { kind: 'template'; templateId: string; displayName: string }
    | {
        kind: 'row';
        rowId: string;
        displayName: string;
        templateProvenanceId: string | null;
      }
    | { kind: 'fallback_to_default'; displayName: string };
  fellBackBecause:
    | null
    | 'unknown_template_id'
    | 'workflow_row_not_found'
    | 'workflow_row_not_owned_by_folder';
};

/** Auto-code Phase 2 — sub-ticket 01KQEED9ARX0QZ25S775WDBQC1.
 *  In-flight rows for a folder; powers the toggle-off popup. */
export interface AutoCodeInflightSummary {
  count: number;
  taskTitles: string[];
}

/** Auto-code Phase 3 — workspace-wide monthly budget snapshot
 *  (sub-ticket 01KQEEE1VSGFMH8T5AEXQENJVW). Mirrors
 *  `src/core/concierge/types.ts AutoCodeBudgetStatus` exactly. */
export interface AutoCodeBudgetStatus {
  spentMonthUsd: number;
  /** Slice 12 of ticket 01KRJSTN74FT7VRX6KAA42GGBS — see core type. */
  meteredSpentMonthUsd: number;
  includedSpentMonthUsd: number;
  spentMonthBreakdown: {
    'auto-code-fix': number;
    'auto-code-review': number;
  };
  monthlyCapUsd: number;
  withinBudget: boolean;
  resetsAt: number;
  /** `'oauth-max'` when Claude is auth'd via subscription tokens,
   *  `'api-key'` when ANTHROPIC_API_KEY is set, null when preflight
   *  didn't resolve. UI uses this to label the cost number — Max
   *  users see "informational" copy because their billing is flat. */
  authSource: 'oauth-max' | 'api-key' | null;
}

/** Echoed by PUT settings when the toggle just disabled auto-code
 *  AND in-flight rows existed at the time of the call. */
export interface AutoCodeCancelSummary {
  cancelledCount: number;
  signaledPids: number[];
  forceKilledPids: number[];
  worktreesRemoved: number;
  worktreeRemovalErrors: Array<{ worktreeName: string; error: string }>;
}

/** One row of the mo_agent_queue table — mirrors AgentQueueRow from
 *  src/core/auto-code/queue.ts. Powers the AutoCodeDrawer's run picker. */
export type AutoCodeQueueState =
  | 'pending'
  | 'fix_running'
  | 'fix_review'
  | 'review_running'
  | 'reopened'
  | 'done'
  | 'done_merged'
  | 'failed'
  | 'cancelled'
  /** Phase 5 — workflow paused at a `human_gate` stage waiting for
   *  the user to reply in the linked Ask Mo session. Clicking the
   *  badge / drawer entry opens that session. */
  | 'paused_ask_user';

export interface AutoCodeQueueRow {
  id: string;
  folderId: string;
  taskId: string;
  state: AutoCodeQueueState;
  attempts: number;
  reopenCount: number;
  repoPath: string;
  worktreeName: string | null;
  fixSessionId: string | null;
  reviewSessionId: string | null;
  lastVerdict: string | null;
  lastError: string | null;
  activePid: number | null;
  sessionGroupId: string | null;
  claimedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Mid-merge probe — only populated by `/runs/batch` for rows in
   *  `done` state. When `inProgress=true && isOurMerge=true`, the
   *  kanban badge surfaces a distinct "mid-merge" pill so the user
   *  can spot stuck cards at a glance. Absent on the legacy
   *  `/runs/:id` single-fetch path. */
  mergeStatus?:
    | { inProgress: false }
    | {
        inProgress: true;
        isOurMerge: boolean;
        mergeHeadRef: string;
        unresolvedCount: number;
      };
}

/** Result envelope from POST /api/auto-code/runs/:id/merge. The
 *  `ok` discriminator lets UI branch cleanly between success
 *  (show summary + close drawer) and failure (show in-modal
 *  error with the actionable message). */
export type AutoCodeMergeResult =
  | {
      ok: true;
      targetBranch: string;
      mergedBranch: string;
      summary: string;
      stat: string | null;
      /** Set when the merge route had to stage + commit
       *  uncommitted worktree changes (Pi / Codex / Claude write
       *  files but don't auto-commit). null = worktree was already
       *  clean OR the worktree directory was gone by merge time. */
      autoCommitted: {
        sha: string;
        filesChanged: number;
        message: string;
      } | null;
    }

/** One unmerged file from `readMergeConflictState` — per-file
 *  ours/theirs/merged content for the ConflictResolverModal. */
export interface AutoCodeConflictFile {
  path: string;
  binary: boolean;
  /** Target-branch (HEAD) content. Null if binary or too large. */
  ours: string | null;
  /** Incoming (worktree branch) content. Null if binary or too large. */
  theirs: string | null;
  /** Working-tree content with conflict markers (`<<<<<<<`, etc.). */
  merged: string;
  oursSize: number | null;
  theirsSize: number | null;
}

/** Response from POST /api/auto-code/runs/:id/merge-conflict-prepare. */
export type AutoCodeMergePrepareResult =
  | {
      ok: true;
      clean: true;
      merge: AutoCodeMergeResult & { ok: true };
    }

/** Response from POST /api/auto-code/runs/:id/merge-apply-resolution. */
export type AutoCodeMergeApplyResult =
  | {
      ok: true;
      sha: string;
      resolved: string[];
      stat: string | null;
    }

/** Response from GET /api/auto-code/runs/:id/merge-status. */
export type AutoCodeMergeStatusResult =
  | {
      ok: true;
      inProgress: false;
    }

/** Per-file resolution result returned by /merge-ai-resolve. */
export type AutoCodeMergeAiResolveFileResult =
  | {
      ok: true;
      path: string;
      content: string;
      modelUsed: 'primary' | 'fallback';
      costUsd: number;
    }

/** Response envelope from POST /api/auto-code/runs/:id/merge-ai-resolve. */
export type AutoCodeMergeAiResolveResult =
  | {
      ok: true;
      results: AutoCodeMergeAiResolveFileResult[];
      totalCostUsd: number;
      okCount: number;
      failedCount: number;
      anyFallback: boolean;
      primaryModel: string;
      fallbackModel: string;
    }

/** Per-file changed entry from `git diff --name-status` +
 *  `--numstat`. Mirrors `ChangedFileEntry` in run-files.ts. */
export interface AutoCodeChangedFile {
  path: string;
  oldPath: string | null;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X' | 'B';
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

/** Result envelope from GET /api/auto-code/runs/:id/files. */
export type AutoCodeRunFilesResult =
  | {
      ok: true;
      targetBranch: string;
      branchName: string;
      files: AutoCodeChangedFile[];
      truncated: boolean;
      totalFiles: number;
    }

/** Result envelope from GET /api/auto-code/runs/:id/files/content. */
export type AutoCodeFileContentResult =
  | {
      ok: true;
      targetBranch: string;
      branchName: string;
      path: string;
      oldPath: string | null;
      status: AutoCodeChangedFile['status'];
      binary: boolean;
      before: string | null;
      after: string | null;
      beforeSize: number | null;
      afterSize: number | null;
      beforeTooLarge: boolean;
      afterTooLarge: boolean;
    }

/** Result envelope from GET /api/auto-code/runs/:id/diff-stat —
 *  mirrors `DiffStatResult` in src/core/auto-code/run-summary.ts.
 *  Powers the "What Mo did" summary section in AutoCodeDrawer. */
export type AutoCodeDiffStatResult =
  | {
      ok: true;
      targetBranch: string;
      branchName: string;
      files: number;
      additions: number;
      deletions: number;
      /** Raw `git diff --shortstat` output. Null when the branch has
       *  no diff against target yet (e.g. agent did nothing). */
      shortStat: string | null;
    }

/** One parsed message from a Claude session transcript. Mirrors
 *  TranscriptMessage in src/core/auto-code/transcript-reader.ts. */
export interface AutoCodeTranscriptMessage {
  id: string;
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  text: string;
  toolUse?: { name: string; input: unknown; id: string };
  toolResult?: { toolUseId: string; content: string; isError: boolean };
  timestamp?: string;
}

export interface AutoCodeTranscriptPayload {
  messages: AutoCodeTranscriptMessage[];
  warnings: string[];
  sessionId?: string;
  transcriptPath?: string;
}

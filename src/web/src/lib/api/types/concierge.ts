/**
 * Mo Concierge domain types — provider, per-pipeline model overrides,
 * per-folder Mo settings, sessions, messages, quick actions, budget.
 */

export interface ConciergeProviderStatus {
  backend: 'groq' | 'openrouter' | 'ollama' | 'openai' | 'anthropic';
  /** For secret-bearing backends (groq/openrouter/openai/anthropic):
   * true iff a key is stored or env-configured. For ollama: true iff
   * a non-default base URL is stored (false = "using default
   * `http://localhost:11434`"). */
  hasApiKey: boolean;
  /** For secret-bearing backends: `…<last 4>` so the UI can confirm
   * which key is active without leaking it into the webview. For
   * ollama: the full base URL (it's not a secret) — UI shows it
   * plainly. */
  apiKeyHint: string;
  model: string;
}

/**
 * Per-pipeline model overrides (Phase 3.5 of epic
 * 01KPGWTJCWVBQCCSQ8NGSB19KQ). Each value is the user-set override
 * for the active backend's slot; empty string means "use the default
 * indexing tier model the resolver picks".
 *
 * Pipelines:
 *   - subagent: gather workers + mo_stage decisions + composeOpening
 *   - synthesis / synthesisThorough: deep-research synth (default vs thorough)
 *   - topicHygiene / topicHygieneFallback: periodic topic-cleanup proposer
 *   - mergeResolver / mergeResolverFallback: auto-code AI merge resolver
 */
export interface PipelineModelValues {
  /** Per-note metadata (summary + keywords) — Tier 1 indexing. High
   *  volume; default Mistral Nemo. */
  tier1: string;
  tier1Fallback: string;
  /** Cluster aggregator + Tier 2.5 catalog — heavier synthesis.
   *  Default Qwen 235B. */
  tier2: string;
  tier2Fallback: string;
  subagent: string;
  synthesis: string;
  synthesisThorough: string;
  topicHygiene: string;
  topicHygieneFallback: string;
  mergeResolver: string;
  mergeResolverFallback: string;
}

export interface PipelineModelsState {
  backend: ConciergeProviderStatus['backend'];
  /** False when the active backend isn't OpenRouter — pipeline-model
   *  overrides are gated to OpenRouter today (the resolvers bail for
   *  other backends). UI uses this to swap the form for an
   *  explanatory banner. */
  pipelinesSupported: boolean;
  values: PipelineModelValues;
  /** Recommended model ids per pipeline (informational typing-aid for
   *  placeholders). Empty string = no recommendation worth showing. */
  recommended: PipelineModelValues;
}

export interface ConciergeFolderSettings {
  folderId: string;
  enabled: boolean;
  /** Auto-code Phase 1 — absolute path to the linked git repo for
   * the kanban → Claude → Codex → Mo loop. Null until the user
   * picks one in the Auto-Code tab. */
  linkedRepoPath: string | null;
  /** Auto-code Phase 1 — per-folder kill switch. Server refuses
   * `true` when `linkedRepoPath` is null. */
  autoCodeEnabled: boolean;
  /** Mo Indexing — per-folder generic-terms blocklist for Tier 1.
   * Free-text; the prompt builder inlines it verbatim. Empty string
   * means no per-folder rules apply (only the workspace-wide
   * category rules, e.g. statuses / OS / environments). */
  topicExclusions: string;
  /** Per-folder Auto-Code workflow template id. Lives in workspace
   *  settings KV; the route mirrors it onto this row for UI symmetry.
   *  Always present on GET; defaults to `'default'`. Patch this field
   *  on PUT to switch templates. */
  workflowTemplate: string;
  /** Per-folder override for the workflow's `mo_start` decision
   *  instruction (Editor Model v2 spec — Morion note
   *  01KRAQWPXR5AYTFVF6J12TYHJ1). Free text. Empty = use whatever the
   *  selected workflow template's own default instruction is. Lives in
   *  workspace settings KV. UI surface: textarea in the folder's
   *  Auto-Code settings panel. */
  intakeInstruction: string;
  /** When true, the orchestrator's done-state hook fires the merge
   *  automatically (same `mergeWorktreeIntoTarget` path the drawer's
   *  "Merge into main" button uses) so the user never has to click
   *  it by hand. Off by default — manual merge is the safe baseline.
   *  Lives in workspace settings KV under
   *  `auto_code.auto_merge.<folderId>`. */
  autoMergeEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Present on GET only — the default prompt prefill for the
   * Workflow textarea's empty state. Writes should omit. */
  workflowDefault?: string;
}

export interface ConciergeSession {
  id: string;
  folderId: string | null;
  title: string;
  openedBy: 'user' | 'concierge';
  needsHuman: boolean;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Server response shape for `GET /api/concierge/sessions/search`.
 * Same fields as `ConciergeSession` plus an optional snippet excerpted
 * around the first matching position in a message body — null when
 * the match was on title only or no message body matched.
 */
export interface ConciergeSessionSearchHit extends ConciergeSession {
  matchSnippet: string | null;
}

export interface ConciergeQuickAction {
  id: string;
  label: string;
  kind: 'primary' | 'secondary' | 'destructive';
  payload: Record<string, unknown>;
}

export interface ConciergeMessage {
  id: string;
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId: string | null;
  costUsd: number;
  tokensIn: number | null;
  tokensOut: number | null;
  model: string | null;
  createdAt: number;
  /** Quick-action buttons under an assistant bubble (topic-cleanup
   *  edge cases, future approvals, etc.). NULL on regular messages. */
  quickActions: ConciergeQuickAction[] | null;
  /** When this user message was created by clicking a quick-action,
   *  this is the action id. Used by the UI to mark used buttons as
   *  resolved (sibling buttons of the same item also collapse). */
  repliedActionId: string | null;
}

export interface QuickActionResult {
  user: ConciergeMessage;
  /** Mo's deterministic ack message echoing the receipt summary. Not
   *  an LLM call — synthetic so users see what landed without latency
   *  or budget cost. */
  assistant: ConciergeMessage;
  receipt: {
    decision: 'merged' | 'kept_separate' | 'demote_tag';
    source: string;
    target: string | null;
    affectedNoteIds?: string[];
    summary: string;
  };
}

export interface ConciergeBudgetStatus {
  spentMonthUsd: number;
  spentMonthBreakdown: {
    chat: number;
    tick: number;
    brief: number;
    mo_tool: number;
    // Narrow Mo kinds — Slice 2 of ticket 01KRJSTN74FT7VRX6KAA42GGBS
    // (migration 0037). Mirrors `src/core/concierge/types.ts`.
    mo_indexing_tier1: number;
    mo_indexing_tier2: number;
    mo_indexing_catalog: number;
    mo_topic_hygiene: number;
    mo_gather: number;
  };
  monthlyCapUsd: number;
  withinBudget: boolean;
  resetsAt: number;
  /** Back-compat: same window's UTC-today subtotal. UI shouldn't use
   * this for the headline number anymore — `spentMonthUsd` is the
   * cap-relevant value. Kept so older surfaces don't break mid-deploy. */
  spentTodayUsd: number;
}

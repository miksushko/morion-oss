/**
 * Direction V — Morion Concierge types.
 *
 * All shapes are JSON-serialisable so they cross the HTTP/WS/MCP
 * boundary unchanged. Booleans are TS booleans at this layer even
 * though SQLite stores them as 0/1 — repos do the conversion.
 */

/**
 * Single source of truth for Mo's audit-log actor string.
 *
 * Used by every mutation Mo performs — `audit_log.actor` rows,
 * `canPerform(ctx.actor, …)` gates, `note_comments.actor`, the
 * `ctx.actor` override in the chat tool-dispatch path. Keep this one
 * constant and import it everywhere — if engine.ts and mo-tools.ts
 * drift, Mo's audit trail splits into two identities with neither
 * having the right permission gates applied.
 *
 * Re-exported as `MO_ACTOR` from `index.ts` for brevity at call sites.
 *
 * **Permission contract** (Phase 3 — context restructure ticket
 * `01KQFQ1RJV7EH0X3WF2H1A476J`): the bare `'morion-concierge'` string
 * is recognised by `canPerform` as a non-MCP actor (no `mcp:` prefix)
 * and gets owner-level access — including archived notes / folders —
 * because Mo is conceptually the user's own assistant, not a third-
 * party MCP client. Sub-Mo orchestration paths INSIDE `mo_*` MCP tool
 * handlers MUST elevate the calling MCP context (`mcp:claude-code`,
 * `mcp:codex`, etc.) to this actor via `toMoInternalCtx(ctx)` before
 * doing internal repo / search work, so Mo can find archived material
 * even when an MCP agent is the entry-point caller. The user controls
 * exclusion via per-folder Mo enablement (`concierge_folder_settings.
 * enabled = false`), NOT via the archive flag.
 */
export const CONCIERGE_ACTOR = 'morion-concierge';

export interface ConciergeFolderSettings {
  folderId: string;
  enabled: boolean;
  /** Auto-code Phase 1 — absolute path to the linked git repo where
   * Mo spawns Claude/Codex worktrees. NULL when the user hasn't picked
   * a repo yet; blocks `autoCodeEnabled` from going true at the route
   * layer. Set via FolderSettingsDialog "Auto-code" tab. */
  linkedRepoPath: string | null;
  /** Auto-code Phase 1 — per-folder kill switch for the kanban →
   * Claude Code → Codex → Mo loop. Pro-gated. Requires
   * `linkedRepoPath` non-null + Mo `enabled` to actually run. */
  autoCodeEnabled: boolean;
  /** Per-folder cap on concurrent in-flight auto-code runs. Overrides
   * the workspace default (MAX_INFLIGHT_PER_FOLDER = 5) when set; the
   * workflow orchestrator's admission gate reads it. NULL = use the
   * workspace default. Set in the FolderSettingsDialog "Auto-code" tab. */
  autoCodeConcurrency: number | null;
  /** Free-text per-folder list of generic terms the user does NOT
   * want Tier 1 to coin as topic ids (e.g. "task management",
   * "agile", "workflow management" for Morion Features). The Tier 1
   * prompt inlines this verbatim when non-empty; empty string means
   * no per-folder exclusions, only the workspace-wide category rules
   * (statuses / OS / environments / etc.) apply. */
  topicExclusions: string;
  createdAt: number;
  updatedAt: number;
}

export type ConciergeSessionOpenedBy = 'user' | 'concierge';

export interface ConciergeSession {
  id: string;
  /** Nullable so a session can be "about the whole workspace" — an
   * Ask Human chat that doesn't belong to a specific board. */
  folderId: string | null;
  title: string;
  openedBy: ConciergeSessionOpenedBy;
  /** 1 = Concierge is waiting on the human; drives the sidebar badge
   * count and the per-session indicator chip. Clears when the user
   * posts a reply. */
  needsHuman: boolean;
  archivedAt: number | null;
  /** Phase 5 (migration 0032) — when this session was created to ask
   *  the user a workflow `human_gate` question, the workflow run id
   *  links the chat back to the paused run. NULL on every other
   *  session (regular Ask Mo chat). The chat route's POST /messages
   *  hook reads this to detect "user reply belongs to a paused run;
   *  trigger resume". */
  workflowRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type ConciergeMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ConciergeMessage {
  id: string;
  sessionId: string;
  role: ConciergeMessageRole;
  /** Markdown for user/assistant/system, JSON-encoded payload for
   * tool rows (provider-specific: tool call args for assistant-emitted
   * calls, tool result bodies for role='tool' follow-ups). */
  content: string;
  /** Set on role='tool' rows so the provider's tool/response pairing
   * round-trips through the next prompt turn intact. */
  toolCallId: string | null;
  /** Billed cost at post-time. SUM(cost_usd) over today's rows gives
   * spend-to-date for the $5 cap — no separate ledger. */
  costUsd: number;
  tokensIn: number | null;
  tokensOut: number | null;
  model: string | null;
  createdAt: number;
  /** Quick-action buttons attached to this assistant message. NULL on
   *  every regular message; populated only when Mo offers a discrete
   *  N-way choice (topic-cleanup edge cases, mo_remember conflict
   *  resolution, etc.). UI renders these as buttons under the bubble. */
  quickActions: ConciergeQuickAction[] | null;
  /** When this user message was created by clicking a quick-action
   *  button, this is the action id from the parent assistant message's
   *  `quickActions[].id`. NULL on organic typed user messages. UI uses
   *  the set of these per-session to mark used buttons as disabled. */
  repliedActionId: string | null;
}

/**
 * Quick-action button attached to an assistant message. Triggers a
 * structured choice instead of asking the user to type a reply
 * matching some text protocol. Each consumer (topic-cleanup,
 * mo_remember conflict, …) defines its own `payload.kind` string +
 * the field shape underneath.
 */
export type ConciergeQuickActionKind = 'primary' | 'secondary' | 'destructive';
export interface ConciergeQuickAction {
  /** Unique within the message. Format is producer's choice; for
   *  topic-cleanup we use `<item-idx>:<verb>` (e.g. `1:merge`,
   *  `1:keep`, `2:demote`) so the UI can group sibling actions. */
  id: string;
  /** Human-readable button text. */
  label: string;
  /** Visual treatment (primary / secondary / destructive). */
  kind: ConciergeQuickActionKind;
  /** Producer-defined payload. The consumer route dispatches on
   *  `payload.kind` and validates the rest of the shape. */
  payload: Record<string, unknown>;
}

// `ConciergeActionKind`, `ConciergeAction`, `ConciergeActionInput` and
// the `concierge_actions` table that backed them were deleted with the
// autonomous Mo agent in ticket `01KQVA65TJ2VCY8VCKH9N5F6W8` (2026-05-05).
// The DB table is left in place (sqlite migrations are forward-only) but
// no code reads or writes it any more.

/**
 * Shape returned by `BudgetTracker.status()` — single source of truth
 * across HTTP, UI, and engine for "can I make another LLM call?". The
 * engine calls this BEFORE every provider request; the UI reads it to
 * decide whether to show a "Budget exhausted, pausing until next
 * month" banner.
 *
 * Window changed from daily-UTC to monthly-UTC and source switched
 * from `concierge_messages.cost_usd` to `mo_spend_ledger` per ticket
 * `01KQ1H556RFFKD7WGZE77MEVFQ` (the old daily cap missed headless
 * tick + brief digest spend). Daily fields preserved for back-compat
 * with any old client surface that still reads them — populated from
 * the same ledger but bounded to today's UTC window.
 */
export interface ConciergeBudgetStatus {
  /** Total USD spent across ALL Mo orchestration sources (chat / tick
   * / brief / mo_tool plus the five narrow kinds split out in
   * migration 0037: mo_indexing_tier1/tier2/catalog, mo_topic_hygiene,
   * mo_gather) since the start of the current UTC calendar month.
   * Excludes auto-code spend — that has its own cap and its own
   * status object. */
  spentMonthUsd: number;
  /** Same Mo-orchestration window, broken down by ledger source.
   * UI shows "chat $X · tick $Y · …" so a runaway path is obvious.
   * Auto-code totals are surfaced via `AutoCodeBudgetStatus` below —
   * different cap, different envelope. */
  spentMonthBreakdown: {
    chat: number;
    tick: number;
    brief: number;
    mo_tool: number;
    /** Narrow Mo kinds split out by Slice 2 of ticket
     *  01KRJSTN74FT7VRX6KAA42GGBS (migration 0037). Pre-split rows
     *  remain bucketed under `mo_tool` so historical data still
     *  surfaces in the legacy field. */
    mo_indexing_tier1: number;
    mo_indexing_tier2: number;
    mo_indexing_catalog: number;
    mo_topic_hygiene: number;
    mo_gather: number;
  };
  /** Monthly hard cap for Mo orchestration; $10 by default per the
   * design call (cheap-tier Gemini + Qwen Plus economics). Tunable
   * per workspace later. */
  monthlyCapUsd: number;
  /** `spent < cap`. False flips the engine to dry-run mode AND fails
   * Mo write tools that go through `requireWithinBudget`. */
  withinBudget: boolean;
  /** ms timestamp of the next reset (start of next UTC month). */
  resetsAt: number;
  /** Total USD spent today (UTC). Compatibility surface for the old
   * `spentTodayUsd` field — kept so existing clients don't break. */
  spentTodayUsd: number;
}

/**
 * Auto-code Phase 3 — separate budget envelope for the kanban → Claude
 * → Codex/claude-fallback loop (sub-ticket 01KQEEE1VSGFMH8T5AEXQENJVW).
 * Tracked apart from the Mo orchestration cap because the dollar shape
 * is wildly different: a single fix-session can burn $0.50-$2; Mo
 * chat turns are sub-cent. Conflating them either starves Mo (auto-
 * code blows the $10 cap on one ticket) or makes the auto-code cap
 * useless (set to $50 and Mo chat will silently bleed into it). The
 * solution is two caps, two ledgers logically — same physical table
 * with different `kind` filters.
 *
 * Note on Max plan vs API: when Claude is auth'd via OAuth Max,
 * `total_cost_usd` from the JSON output is **informational** — actual
 * billing is the monthly subscription, not pay-per-use. Surface the
 * metric anyway (it's a useful proxy for "usage quota burn") but the
 * UI labels it accordingly via `authSource`.
 */
export interface AutoCodeBudgetStatus {
  /** Total USD recorded for auto-code spawns (fix + review + merge
   *  resolve) since the start of the current UTC calendar month —
   *  equivalent API price across ALL rows regardless of billing
   *  mode. Sums every row where `kind LIKE 'auto-code-%'`. UI shows
   *  this as the headline gross number. */
  spentMonthUsd: number;
  /** Subset of `spentMonthUsd` that's actually metered (real $ —
   *  `auth_mode IS NULL OR 'api'`). Slice 12 of ticket
   *  01KRJSTN74FT7VRX6KAA42GGBS. The cap progress bar uses this —
   *  a Claude OAuth Max user can run unlimited subscription-covered
   *  fixes without sliding the cap. */
  meteredSpentMonthUsd: number;
  /** Subset of `spentMonthUsd` covered by subscription
   *  (`auth_mode = 'subscription'`). Informational equivalent API
   *  price; nothing actually charged. */
  includedSpentMonthUsd: number;
  /** Per-source breakdown — UI shows "fix $4.20 · review $0.80
   *  · resolve $0.12". */
  spentMonthBreakdown: {
    'auto-code-fix': number;
    'auto-code-review': number;
    'auto-code-merge-resolve': number;
  };
  /** Monthly hard cap for auto-code, in USD. Read from workspace
   * setting `auto_code.monthly_budget_usd`; defaults to $50 when
   * unset (a heavy dogfood user lands around $20-30/mo, leaving
   * headroom). */
  monthlyCapUsd: number;
  /** `spent < cap`. False makes the orchestrator refuse new claims
   * and mark pending rows with `last_error='auto_code_budget_exhausted'`.
   * In-flight runs complete naturally — the cap is on NEW claims,
   * not running work. */
  withinBudget: boolean;
  /** ms timestamp of the next reset (start of next UTC month). */
  resetsAt: number;
  /** How Claude is authed today. Pulled from preflight: `'oauth-max'`
   * when the binary picks up OAuth tokens (Max plan), `'api-key'`
   * when ANTHROPIC_API_KEY is set. The UI uses this to label the
   * cost number — Max users see "equivalent API cost" copy because
   * their billing is subscription-flat. `null` when preflight didn't
   * resolve a binary or the auth probe failed. */
  authSource: 'oauth-max' | 'api-key' | null;
}

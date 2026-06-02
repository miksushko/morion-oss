import type { LLMProvider } from '../../../concierge/provider.js';
import type { BudgetTracker } from '../../../concierge/budget.js';

/**
 * Public types for the MoMessengerDispatcher. Extracted from
 * mo-messenger-dispatcher.ts during the 2026-05-16 split (Morion
 * ticket 01KRQYV48RJJN952BE3GSK0CSB).
 */

export interface ComposeOpeningInput {
  ticketTitle: string;
  ticketBody: string;
  /** Recent ticket comments (newest first), preformatted. Already
   *  truncated by caller to fit Mo's prompt budget. */
  recentComments: string;
  /** Prior stage outputs (cli_agent summaries, mo decisions) keyed
   *  by stage id; serialized snippet form. */
  priorStageOutputs: string;
  /** Workflow-author's optional hint (`human_gate.guidance` field).
   *  Empty / undefined = Mo composes purely from context. */
  guidance: string | undefined;
  /** Folder scope for provider / model resolution. */
  folderId: string | null;
}

export interface SummarizeStageInput {
  ticketTitle: string;
  ticketBody: string;
  /** Stage id in the workflow graph — surfaces in the user-readable
   *  comment as the "what just happened" anchor. */
  stageId: string;
  agentName: string | null;
  /** Agent's verbatim summary string from its ResultEvent. Capped
   *  upstream to keep prompt budget honest. */
  agentSummary: string;
  /** Whether the stage failed / cancelled (Mo phrases differently). */
  terminalStatus: 'done' | 'failed' | 'cancelled';
  folderId: string | null;
}

export interface ContinueChatInput {
  ticketTitle: string;
  ticketBody: string;
  /** Full chat history this session, role-tagged + ordered chronologically.
   *  Mo reads it to decide if the user's latest reply is actionable. */
  chatHistory: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  /** The current `human_gate` stage's optional guidance hint — keeps
   *  Mo aligned with the workflow author's original intent across
   *  multi-turn. */
  guidance: string | undefined;
  folderId: string | null;
}

export interface MoMessengerComposeResult {
  ok: true;
  summary: string;
  question: string;
  costUsd: number;
}

export interface MoMessengerSummarizeResult {
  ok: true;
  comment: string;
  costUsd: number;
}

export interface MoMessengerContinueChatResult {
  ok: true;
  action: 'reply' | 'resume';
  /** Mo's next visible message in the chat (always present). */
  userMessage: string;
  /** Machine-readable summary of the user's decision, threaded into
   *  the next mo_stage's reopen-context. Present only on
   *  `action='resume'`. NEVER shown to the user. */
  resumeSummary?: string;
  costUsd: number;
}

export type MoMessengerFailure = {
  ok: false;
  error:
    | 'mo_provider_unconfigured'
    | 'mo_model_unconfigured'
    | 'mo_budget_exceeded'
    | 'mo_provider_error'
    | 'mo_decision_unparseable';
  message: string;
};

export interface MoMessengerDispatcher {
  composeOpening(
    input: ComposeOpeningInput,
  ): Promise<MoMessengerComposeResult | MoMessengerFailure>;
  summarizeStage(
    input: SummarizeStageInput,
  ): Promise<MoMessengerSummarizeResult | MoMessengerFailure>;
  /** Commit C — multi-turn chat. Called on every user reply in a
   *  workflow-linked Ask Mo session while the run is `paused_ask_user`.
   *  Returns {action:'reply'} (post another assistant message, keep
   *  waiting) or {action:'resume'} (summary text becomes reopen-context
   *  for the next mo_stage). */
  continueChat(
    input: ContinueChatInput,
  ): Promise<MoMessengerContinueChatResult | MoMessengerFailure>;
}

export interface ProductionMoMessengerDispatcherDeps {
  resolveProvider: (folderId: string | null) => LLMProvider | null;
  resolveModel: (folderId: string | null) => string | null;
  budget: BudgetTracker;
}

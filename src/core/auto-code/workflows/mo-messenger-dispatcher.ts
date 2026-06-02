/**
 * Phase 6 V2 (Morion ticket 01KRG02E2SV2F9F3PZ6TPDDCNA) —
 * `MoMessengerDispatcher`.
 *
 * Shared chat-tier LLM layer for the "Mo as conversational lead"
 * callsites in the workflow runner:
 *
 *   1. `composeOpening` — at workflow `human_gate` entry. Mo reads
 *      ticket + recent comments + prior stage outputs + the
 *      workflow author's `guidance` hint, then composes a 2-piece
 *      chat opening (summary line + the specific question).
 *
 *   2. `summarizeStage` — at cli_agent `onStageEnd`. Mo reads the
 *      agent's verbatim output and produces a 1-2 sentence
 *      "what happened" comment for the ticket activity feed.
 *
 *   3. `continueChat` — multi-turn chat while the run is
 *      `paused_ask_user`. Returns reply / resume + machine-readable
 *      `resumeSummary` for the next mo_stage's reopen-context.
 *
 * Composition barrel — all logic lives in `./mo-messenger-dispatcher/`:
 *   - `types.ts`                 public input/output types + dispatcher
 *                                interface + factory deps.
 *   - `helpers.ts`               preflight + mapFailure + truncate.
 *   - `role-compose-opening.ts`  composeOpening role + schema + scope.
 *   - `role-summarize-stage.ts`  summarizeStage role + schema + scope.
 *   - `role-continue-chat.ts`    continueChat role + schema + scope.
 *   - `factory.ts`               buildProductionMoMessengerDispatcher.
 *
 * Per the 2026-05-16 split (Morion ticket 01KRQYV48RJJN952BE3GSK0CSB),
 * importers should keep using
 * `src/core/auto-code/workflows/mo-messenger-dispatcher.js` — this
 * barrel preserves the pre-split public surface verbatim.
 */
export type {
  ComposeOpeningInput,
  SummarizeStageInput,
  ContinueChatInput,
  MoMessengerComposeResult,
  MoMessengerSummarizeResult,
  MoMessengerContinueChatResult,
  MoMessengerFailure,
  MoMessengerDispatcher,
  ProductionMoMessengerDispatcherDeps,
} from './mo-messenger-dispatcher/types.js';
export { buildProductionMoMessengerDispatcher } from './mo-messenger-dispatcher/factory.js';

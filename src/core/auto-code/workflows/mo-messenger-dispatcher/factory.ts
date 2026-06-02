import { runSubMoTask } from '../../../concierge/sub-mo-template.js';
import { mapFailure, preflight } from './helpers.js';
import {
  buildComposeOpeningScope,
  composeOpeningRole,
} from './role-compose-opening.js';
import {
  buildSummarizeStageScope,
  summarizeStageRole,
} from './role-summarize-stage.js';
import {
  buildContinueChatScope,
  continueChatRole,
} from './role-continue-chat.js';
import type {
  MoMessengerDispatcher,
  ProductionMoMessengerDispatcherDeps,
} from './types.js';

/**
 * Build a real `MoMessengerDispatcher` from chat-tier deps. The
 * factory wires this into the workflow runner's `humanGateHandler`
 * (composeOpening / continueChat) and `onStageEnd` hook (summarizeStage).
 *
 * Extracted from mo-messenger-dispatcher.ts during the 2026-05-16
 * split (Morion ticket 01KRQYV48RJJN952BE3GSK0CSB).
 */
export function buildProductionMoMessengerDispatcher(
  deps: ProductionMoMessengerDispatcherDeps,
): MoMessengerDispatcher {
  return {
    async composeOpening(input) {
      const guard = preflight(deps, input.folderId);
      if (guard) return guard;
      const provider = deps.resolveProvider(input.folderId);
      const model = deps.resolveModel(input.folderId);
      if (!provider || !model) {
        // preflight already covered these — defensive narrow.
        return {
          ok: false,
          error: 'mo_provider_unconfigured',
          message: 'Provider or model not resolved.',
        };
      }
      const userScope = buildComposeOpeningScope(input);
      const result = await runSubMoTask(
        { provider, model, budget: deps.budget },
        composeOpeningRole,
        userScope,
        { folderId: input.folderId, temperature: 0.3 },
      );
      if (!result.ok) return mapFailure(result);
      return {
        ok: true,
        summary: result.data.summary,
        question: result.data.question,
        costUsd: result.costUsd,
      };
    },
    async continueChat(input) {
      const guard = preflight(deps, input.folderId);
      if (guard) return guard;
      const provider = deps.resolveProvider(input.folderId);
      const model = deps.resolveModel(input.folderId);
      if (!provider || !model) {
        return {
          ok: false,
          error: 'mo_provider_unconfigured',
          message: 'Provider or model not resolved.',
        };
      }
      const userScope = buildContinueChatScope(input);
      const result = await runSubMoTask(
        { provider, model, budget: deps.budget },
        continueChatRole,
        userScope,
        { folderId: input.folderId, temperature: 0.3 },
      );
      if (!result.ok) return mapFailure(result);
      const summary =
        result.data.action === 'resume' && result.data.resumeSummary
          ? result.data.resumeSummary
          : undefined;
      return {
        ok: true,
        action: result.data.action,
        userMessage: result.data.userMessage,
        ...(summary ? { resumeSummary: summary } : {}),
        costUsd: result.costUsd,
      };
    },
    async summarizeStage(input) {
      const guard = preflight(deps, input.folderId);
      if (guard) return guard;
      const provider = deps.resolveProvider(input.folderId);
      const model = deps.resolveModel(input.folderId);
      if (!provider || !model) {
        return {
          ok: false,
          error: 'mo_provider_unconfigured',
          message: 'Provider or model not resolved.',
        };
      }
      const userScope = buildSummarizeStageScope(input);
      const result = await runSubMoTask(
        { provider, model, budget: deps.budget },
        summarizeStageRole,
        userScope,
        { folderId: input.folderId, temperature: 0.2 },
      );
      if (!result.ok) return mapFailure(result);
      return {
        ok: true,
        comment: result.data.comment,
        costUsd: result.costUsd,
      };
    },
  };
}

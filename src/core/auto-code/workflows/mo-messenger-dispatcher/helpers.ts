import type {
  MoMessengerFailure,
  ProductionMoMessengerDispatcherDeps,
} from './types.js';

/**
 * Shared dispatcher helpers — pre-flight gates, `runSubMoTask` failure
 * mapping, prompt-budget truncation. Extracted during the 2026-05-16
 * split (Morion ticket 01KRQYV48RJJN952BE3GSK0CSB).
 */

/** Shared pre-flight checks for every dispatcher entry point.
 *  Mirrors `buildProductionMoStageDispatcher`'s gates so a workspace
 *  where Mo isn't configured / budget exhausted fails cleanly
 *  regardless of which Mo callsite triggers. */
export function preflight(
  deps: ProductionMoMessengerDispatcherDeps,
  folderId: string | null,
): MoMessengerFailure | null {
  const provider = deps.resolveProvider(folderId);
  if (!provider) {
    return {
      ok: false,
      error: 'mo_provider_unconfigured',
      message:
        'Mo provider is not configured for this folder. Set OpenRouter / Claude / Groq backend with an API key in Settings → Mo.',
    };
  }
  const model = deps.resolveModel(folderId);
  if (!model) {
    return {
      ok: false,
      error: 'mo_model_unconfigured',
      message:
        'No model resolved for the active Mo backend. Set a default model in workspace settings.',
    };
  }
  const status = deps.budget.status();
  if (status.withinBudget === false) {
    return {
      ok: false,
      error: 'mo_budget_exceeded',
      message: `Mo monthly budget exhausted: $${status.spentMonthUsd.toFixed(2)} / $${status.monthlyCapUsd}. Resets at the start of the next UTC month.`,
    };
  }
  return null;
}

export function mapFailure(result: {
  reason: string;
  errorMessage?: string | undefined;
  raw?: string;
}): MoMessengerFailure {
  if (result.reason === 'provider_error') {
    return {
      ok: false,
      error: 'mo_provider_error',
      message: result.errorMessage ?? 'provider error',
    };
  }
  return {
    ok: false,
    error: 'mo_decision_unparseable',
    message: `Mo's reply could not be parsed: ${result.reason}${result.errorMessage ? '; ' + result.errorMessage : ''}.${result.raw ? ' Raw head: ' + result.raw.slice(0, 200) : ''}`,
  };
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…(truncated, ${s.length - max} chars elided)`;
}

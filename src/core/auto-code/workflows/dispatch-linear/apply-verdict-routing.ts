import { formatReopenReason } from '../runner-helpers.js';
import { routeVerdict } from '../route-verdict.js';
import { parseVerdict } from '../verdict.js';
import type {
  InternalRunState,
  StageExecutorContext,
} from '../runner-types.js';

/** What the linear walker should do AFTER applying a verdict-policy
 *  decision: advance to the next array index, jump back to a reopen
 *  target, or terminate the run with an error. */
export type VerdictRoutingResult =
  | { kind: 'advance'; nextIndex: number }
  | { kind: 'reopen'; nextIndex: number }
  | { kind: 'terminate'; reason: string };

/**
 * Translate a verdict-policy decision into a walker action.
 *
 * Side effects: clears `state.reopenContext` on `approve`, populates
 * it on `reopen`. `terminate` decisions return the reason string for
 * the shell to feed to `ctx.terminate(state, 'failed', reason)`.
 *
 * Caller invariant: `currentIndex` is the index of the stage that
 * just completed, so the natural advance is `currentIndex + 1`.
 */
export function applyVerdictRouting(
  ctx: StageExecutorContext,
  state: InternalRunState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stage: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stages: any[],
  currentIndex: number,
): VerdictRoutingResult {
  const summary =
    (state.stageOutputs[stage.id]?.output.summary as string | undefined) ??
    '';
  const parsed = parseVerdict(summary);
  const decision = routeVerdict(parsed.verdict, stage, stages, {
    runId: state.runId,
    repo: ctx.deps.repo,
  });
  switch (decision.kind) {
    case 'approve':
      // Fall through to linear advance.
      state.reopenContext = {};
      return { kind: 'advance', nextIndex: currentIndex + 1 };
    case 'reopen': {
      state.reopenContext = {
        reason: formatReopenReason(parsed.reason, stage.id),
        fromStageId: stage.id,
      };
      return { kind: 'reopen', nextIndex: decision.targetIndex };
    }
    case 'escalate': {
      return {
        kind: 'terminate',
        reason: `escalated_by_review: ${parsed.reason || '(no reason given)'}`,
      };
    }
    case 'reopen_cap_exhausted': {
      return {
        kind: 'terminate',
        reason: `reopen_cap_exhausted: stage "${decision.reopenStageId}" already executed ${decision.attempts} times (cap ${decision.cap})`,
      };
    }
    case 'misconfigured': {
      return { kind: 'terminate', reason: decision.reason };
    }
  }
}

/**
 * Reviewer-verdict routing for `cli_agent` stages.
 *
 * Pure function of (verdict, stage, snapshot stages, persisted attempt
 * counts) — pulled out of `WorkflowRunner` as a standalone module so
 * it can be unit-tested without spinning the runner. The only side
 * input is `repo.latestAttemptForStage` for the reopen-cap check.
 *
 * Stage 3 of the runner.ts decomposition (ticket
 * 01KRJYYZ3YE57V1PM06ACBDS0T).
 */

import type { WorkflowRunsRepository } from './runs-repository.js';
import type { VerdictPolicy, WorkflowStage } from './types/index.js';

export type VerdictDecision =
  | { kind: 'approve' }
  | { kind: 'reopen'; targetIndex: number }
  | { kind: 'escalate' }
  | {
      kind: 'reopen_cap_exhausted';
      reopenStageId: string;
      attempts: number;
      cap: number;
    }
  | { kind: 'misconfigured'; reason: string };

export function routeVerdict(
  verdict: 'approve' | 'reopen' | 'escalate',
  stage: Extract<WorkflowStage, { kind: 'cli_agent' }>,
  stages: readonly WorkflowStage[],
  ctx: { runId: string; repo: WorkflowRunsRepository },
): VerdictDecision {
  if (verdict === 'approve') return { kind: 'approve' };
  if (verdict === 'escalate') return { kind: 'escalate' };
  // verdict === 'reopen'
  const policy: VerdictPolicy = stage.verdictPolicy!;
  if (!policy.onReopen) {
    return {
      kind: 'misconfigured',
      reason: `verdict_misconfigured: stage "${stage.id}" emitted "reopen" but verdictPolicy.onReopen is unset`,
    };
  }
  const targetIndex = stages.findIndex(
    (s) => s.id === policy.onReopen!.reopenStageId,
  );
  if (targetIndex < 0) {
    return {
      kind: 'misconfigured',
      reason: `verdict_misconfigured: onReopen.reopenStageId "${policy.onReopen.reopenStageId}" not in workflow stages`,
    };
  }
  const cap = policy.onReopen.maxAttempts;
  const latest = ctx.repo.latestAttemptForStage(
    ctx.runId,
    policy.onReopen.reopenStageId,
  );
  const attempts = latest?.attempt ?? 0;
  if (attempts >= cap) {
    return {
      kind: 'reopen_cap_exhausted',
      reopenStageId: policy.onReopen.reopenStageId,
      attempts,
      cap,
    };
  }
  return { kind: 'reopen', targetIndex };
}

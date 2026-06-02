import { z } from 'zod';
import type { RefinementCtx, RefinementDef } from './types.js';

/** verdictPolicy targets: validate every onReopen.reopenStageId
 *  exists, points BEFORE the policy stage in array order (linear
 *  graphs only; pointing forward or to the same stage doesn't have
 *  a sensible loop semantics for L2), and that the target's
 *  `maxAttempts` cap can absorb the policy's reopen cap. Without
 *  this a typo silently burns a fix+review budget before failing
 *  at runtime, and a same/forward target loops oddly. */
export function checkVerdictPolicyTargets(def: RefinementDef, ctx: RefinementCtx): void {
  def.stages.forEach((stage, idx) => {
    if (stage.kind !== 'cli_agent') return;
    const policy = stage.verdictPolicy;
    if (!policy?.onReopen) return;
    const targetIdx = def.stages.findIndex((s) => s.id === policy.onReopen!.reopenStageId);
    if (targetIdx < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages', idx, 'verdictPolicy', 'onReopen', 'reopenStageId'],
        message: `verdictPolicy.onReopen.reopenStageId "${policy.onReopen.reopenStageId}" does not match any stage id`,
      });
      return;
    }
    if (targetIdx >= idx) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages', idx, 'verdictPolicy', 'onReopen', 'reopenStageId'],
        message: `verdictPolicy.onReopen.reopenStageId "${policy.onReopen.reopenStageId}" must point to an EARLIER stage in the array (linear-only loops); got index ${targetIdx} from policy stage at index ${idx}`,
      });
      return;
    }
    const target = def.stages[targetIdx]!;
    if (target.kind !== 'cli_agent') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['stages', idx, 'verdictPolicy', 'onReopen', 'reopenStageId'],
        message: `verdictPolicy.onReopen.reopenStageId "${policy.onReopen.reopenStageId}" targets a non-cli_agent stage (kind="${target.kind}")`,
      });
      return;
    }
    // Every stage from the reopen target through the policy stage
    // (inclusive) gets re-executed on each loop iteration, so each
    // one needs `maxAttempts >= policy cap`. The runner trips a
    // `stage_max_attempts_exceeded` failure otherwise — catch the
    // misconfig at parse time so reviewers don't waste a fix budget
    // before the failure surfaces on the SECOND review attempt.
    //
    // Codex P2b (2026-05-10) — `mcp_tool_call` stages have their
    // own `maxAttempts` cap and ALSO re-execute inside the reopen
    // loop. Validate them with the same rule; previous `cli_agent`-
    // only filter let MCP-stage misconfigs slip past parse-time.
    for (let k = targetIdx; k <= idx; k++) {
      const loopStage = def.stages[k]!;
      if (
        loopStage.kind !== 'cli_agent' &&
        loopStage.kind !== 'mcp_tool_call'
      ) {
        continue;
      }
      if (loopStage.maxAttempts < policy.onReopen.maxAttempts) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stages', idx, 'verdictPolicy', 'onReopen', 'maxAttempts'],
          message: `verdictPolicy.onReopen.maxAttempts (${policy.onReopen.maxAttempts}) exceeds stage "${loopStage.id}" maxAttempts (${loopStage.maxAttempts}) — every stage in the reopen loop (from "${target.id}" through "${stage.id}") needs maxAttempts >= ${policy.onReopen.maxAttempts}`,
        });
      }
    }
  });
}

/**
 * `reject_sink` / `complete_sink` / `eject` stage executor.
 *
 * Records a stage row carrying the rendered commentTemplate on
 * `output.comment` so orchestrator hooks can surface it to the ticket;
 * terminates the run with the appropriate status.
 *
 * Reject sinks use `status='failed'` + `REJECTED_BY_WORKFLOW_PREFIX`
 * lastError so orchestrator hooks branch on the prefix (skip the
 * `auto-code-paused` tag — workflow deliberately bounced this, not an
 * infrastructure failure) but still move the ticket to backlog.
 *
 * Stage 5 of the runner.ts decomposition (ticket
 * 01KRJYYZ3YE57V1PM06ACBDS0T).
 */

import { renderPromptTemplate } from './template.js';
import { REJECTED_BY_WORKFLOW_PREFIX } from './runner-defaults.js';
import type {
  InternalRunState,
  StageExecutorContext,
  TicketContext,
} from './runner-types.js';
import type { WorkflowStage } from './types/index.js';

export async function runSinkStage(
  ctx: StageExecutorContext,
  state: InternalRunState,
  stage: Extract<
    WorkflowStage,
    { kind: 'reject_sink' | 'complete_sink' | 'eject' }
  >,
  ticket: TicketContext,
  sinkKind: 'reject' | 'complete',
): Promise<void> {
  const { repo } = ctx.deps;
  const commentTemplate =
    stage.kind === 'eject'
      ? stage.reason ?? ''
      : stage.commentTemplate ?? '';
  const renderedComment = commentTemplate
    ? renderPromptTemplate(commentTemplate, {
        ticket,
        stages: state.stageOutputs,
        reopen: state.reopenContext,
      }).output
    : '';

  const priorAttempt = repo.latestAttemptForStage(state.runId, stage.id);
  const nextAttempt = (priorAttempt?.attempt ?? 0) + 1;
  const stageRow = repo.createStage(
    {
      runId: state.runId,
      stageIdInGraph: stage.id,
      stageKind: stage.kind,
      agentName: null,
      attempt: nextAttempt,
      initialStatus: 'running',
    },
    ctx.now(),
  );
  repo.updateRun(state.runId, { currentStageId: stage.id }, ctx.now());
  {
    const freshRun = repo.getRun(state.runId);
    if (freshRun) {
      await ctx.runHook('onStageStart', state.hooks.onStageStart, {
        run: freshRun,
        stage,
        stageRow,
        attempt: nextAttempt,
      });
    }
  }
  const now = ctx.now();
  const output: Record<string, unknown> = {
    sinkKind,
    comment: renderedComment,
  };
  repo.updateStage(
    stageRow.id,
    { status: 'done', finishedAt: now, output },
    now,
  );
  await ctx.fireStageEndHook(state, stage);
  if (sinkKind === 'complete') {
    await ctx.terminate(state, 'done', null);
    return;
  }
  const reason = renderedComment || `ejected at "${stage.id}"`;
  await ctx.terminate(
    state,
    'failed',
    `${REJECTED_BY_WORKFLOW_PREFIX} ${reason}`,
  );
}

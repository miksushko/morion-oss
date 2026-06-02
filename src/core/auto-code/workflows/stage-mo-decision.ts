/**
 * `mo_stage` (or legacy alias `mo_router`) decision-node executor.
 *
 * Calls the injected `MoStageDispatcher`, validates the picked branch
 * is one of `stage.branches`, persists the decision on the stage row
 * (with optional comment text for orchestrator hooks to post), then
 * resolves the outbound edge by label.
 *
 * On unrecoverable failure (dispatcher errored, picked an unknown
 * branch, no outbound edge for the picked branch) terminates the run
 * with a clear envelope.
 *
 * Includes the Phase 6 V2 reopen-context plumb (userReply consumption
 * on loop-back paths, ticket 01KRMA2WWK65K42MD3Q34GE5YJ).
 *
 * Stage 7 of the runner.ts decomposition (ticket
 * 01KRJYYZ3YE57V1PM06ACBDS0T).
 */

import { findOutboundByLabel } from './runner-helpers.js';
import type {
  InternalRunState,
  StageExecutorContext,
  TicketContext,
} from './runner-types.js';
import type { WorkflowEdge, WorkflowStage } from './types/index.js';

export type MoStageOutcome =
  | { kind: 'terminated' }
  | { kind: 'advance'; nextStageId: string };

export async function runMoStageNode(
  ctx: StageExecutorContext,
  state: InternalRunState,
  stage: Extract<WorkflowStage, { kind: 'mo_stage' | 'mo_router' }>,
  ticket: TicketContext,
  edges: readonly WorkflowEdge[],
): Promise<MoStageOutcome> {
  const { repo } = ctx.deps;
  const branches =
    stage.kind === 'mo_stage' ? stage.branches : stage.branches;
  if (!branches || branches.length === 0) {
    await ctx.terminate(
      state,
      'failed',
      `mo_stage_misconfigured: stage "${stage.id}" has no branches — Mo can't pick a path`,
    );
    return { kind: 'terminated' };
  }

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

  // mo_router (legacy) has only `prompt` / `branches`. mo_stage has
  // the full v2 fields. Build a unified MoStage shape for the
  // dispatcher — narrow up-front so the dispatcher doesn't branch
  // on stage.kind.
  const moStageShim =
    stage.kind === 'mo_stage'
      ? stage
      : ({
          id: stage.id,
          kind: 'mo_stage' as const,
          instruction: stage.prompt,
          branches: stage.branches,
          postComment: true,
          isStart: false,
          allowedTools: null,
        } as Extract<WorkflowStage, { kind: 'mo_stage' }>);

  let dispatchResult;
  try {
    const run = repo.getRun(state.runId);
    dispatchResult = await ctx.moStageDispatcher.decide({
      runId: state.runId,
      folderId: run?.folderId ?? '',
      ticketId: run?.ticketId ?? '',
      stage: moStageShim,
      ticket,
      stageOutputs: state.stageOutputs,
      reopenContext: state.reopenContext,
      worktreePath: run?.worktreePath ?? '',
      graphSnapshot: run?.graphSnapshot ?? {
        schemaVersion: 1,
        name: '',
        description: '',
        stages: [],
        edges: [],
      },
    });
  } catch (err) {
    dispatchResult = {
      ok: false as const,
      error: 'mo_stage_threw',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const stageNow = ctx.now();

  // Re-check cancel after the dispatcher await (parallel to
  // runMcpToolStage's Codex P1b fix).
  const postFresh = repo.getRun(state.runId);
  if (ctx.isCancelled(state) || postFresh?.cancelRequested) {
    const cancelReason =
      state.cancelReason ?? postFresh?.lastError ?? 'cancel_requested';
    repo.updateStage(
      stageRow.id,
      { status: 'cancelled', finishedAt: stageNow, lastError: cancelReason },
      stageNow,
    );
    await ctx.fireStageEndHook(state, stage);
    await ctx.terminate(state, 'cancelled', cancelReason);
    return { kind: 'terminated' };
  }

  if (!dispatchResult.ok) {
    const errorLine = `mo_stage_failed:${dispatchResult.error}${
      dispatchResult.message ? `: ${dispatchResult.message}` : ''
    }`;
    repo.updateStage(
      stageRow.id,
      { status: 'failed', finishedAt: stageNow, lastError: errorLine },
      stageNow,
    );
    await ctx.fireStageEndHook(state, stage);
    await ctx.terminate(state, 'failed', errorLine);
    return { kind: 'terminated' };
  }

  const branch = dispatchResult.branch;
  if (!branches.includes(branch)) {
    const errorLine = `mo_stage_invalid_branch: Mo picked "${branch}" but stage "${stage.id}" only declares [${branches.map((b) => `"${b}"`).join(', ')}]`;
    repo.updateStage(
      stageRow.id,
      {
        status: 'failed',
        finishedAt: stageNow,
        lastError: errorLine,
        output: { branch, reason: dispatchResult.reason },
      },
      stageNow,
    );
    await ctx.fireStageEndHook(state, stage);
    await ctx.terminate(state, 'failed', errorLine);
    return { kind: 'terminated' };
  }

  const cost =
    typeof dispatchResult.costUsd === 'number' && dispatchResult.costUsd >= 0
      ? dispatchResult.costUsd
      : 0;
  const postComment =
    stage.kind === 'mo_stage' ? stage.postComment !== false : true;
  const commentBody = postComment
    ? `Mo decided: \`${branch}\`. ${dispatchResult.reason}`.trim()
    : '';
  const output: Record<string, unknown> = {
    branch,
    reason: dispatchResult.reason,
    ...(commentBody ? { comment: commentBody } : {}),
  };
  repo.updateStage(
    stageRow.id,
    {
      status: 'done',
      finishedAt: stageNow,
      output,
      costUsd: cost,
    },
    stageNow,
  );
  if (cost > 0) {
    const runRow = repo.getRun(state.runId);
    if (runRow) {
      repo.updateRun(
        state.runId,
        { totalCostUsd: runRow.totalCostUsd + cost },
        stageNow,
      );
    }
  }
  state.stageOutputs[stage.id] = { output };
  await ctx.fireStageEndHook(state, stage);

  const nextStageId = findOutboundByLabel(edges, stage.id, branch);
  if (nextStageId === null) {
    const errorLine = `mo_stage_no_outbound_edge: Mo picked "${branch}" on stage "${stage.id}" but no outbound edge has on="${branch}". Wire the branch in the editor.`;
    await ctx.terminate(state, 'failed', errorLine);
    return { kind: 'terminated' };
  }

  // Phase 6 V2 hotfix (2026-05-13) — Bug #1: when Mo's decision
  // routes BACK to a previously-executed stage (loop-back path,
  // typically post-human_gate re-open into a cli_agent), populate
  // state.reopenContext so the target stage's prompt template can
  // render {{reopen.reason}} / {{reopen.userReply}} and pick up
  // the user's answer. Without this, Pi/Claude get a fresh prompt
  // with no awareness of the user's reply.
  //
  // The user reply lives on the most-recent human_gate stage's
  // output (carried by repo.resumeFromHumanGate). We surface it
  // as `reopen.userReply` AND fold it into `reopen.reason` so
  // existing prompt templates that only template `{{reopen.reason}}`
  // (the v2 default-autocode shape) still pick it up.
  if (state.stageOutputs[nextStageId]) {
    // Pluck the most-recent unconsumed userReply from a prior
    // human_gate. Track BOTH the value and its source stage id so
    // we can mark it consumed below.
    //
    // Bug fix (ticket 01KRMA2WWK65K42MD3Q34GE5YJ, 2026-05-15):
    // Previously this loop greedily grabbed the last-seen userReply
    // without clearing it. A workflow with a re-open edge from
    // mo_after_fix → cli_agent would feed Mo the SAME user reply on
    // every loop iteration after the first human_gate, even when no
    // new human input had arrived. Mo's DECISION HIERARCHY treats
    // `## User just answered your question` as a forced loop-back
    // signal, so the dispatcher kept re-opening until
    // stage_max_attempts_exceeded.
    //
    // Fix: consume the userReply by clearing it on the source stage
    // (in-memory + persisted via repo.updateStage) the moment it's
    // folded into reopenContext. Sidecar restart mid-run can't
    // re-load the stale value because the stage's output_json no
    // longer carries it.
    let userReply: string | undefined;
    let userReplySource: string | undefined;
    for (const [stageId, payload] of Object.entries(state.stageOutputs)) {
      const ur = (payload.output as Record<string, unknown> | undefined)
        ?.userReply;
      if (typeof ur === 'string' && ur.trim().length > 0) {
        userReply = ur;
        userReplySource = stageId;
      }
    }
    const reopenReason = userReply
      ? `User answered via human_gate: ${userReply}\n\nMo routing rationale: ${dispatchResult.reason}`
      : dispatchResult.reason;
    state.reopenContext = {
      reason: reopenReason,
      fromStageId: stage.id,
      branch,
      ...(userReply ? { userReply } : {}),
    };
    if (userReply && userReplySource) {
      const sourcePayload = state.stageOutputs[userReplySource];
      if (sourcePayload && typeof sourcePayload.output === 'object') {
        const consumedOutput: Record<string, unknown> = {
          ...(sourcePayload.output as Record<string, unknown>),
          userReply: '',
        };
        state.stageOutputs[userReplySource] = { output: consumedOutput };
        // Persist the cleared field on the stage row so a sidecar
        // restart mid-run doesn't re-load the stale userReply from
        // the human_gate's output_json.
        const sourceRowId = repo.latestAttemptForStage(
          state.runId,
          userReplySource,
        )?.id;
        if (sourceRowId) {
          repo.updateStage(sourceRowId, { output: consumedOutput }, Date.now());
        }
      }
    }
  } else {
    // Forward path — clear stale reopen context so the next
    // stage's template can't accidentally see a previous loop's
    // reason.
    state.reopenContext = {};
  }

  return { kind: 'advance', nextStageId };
}

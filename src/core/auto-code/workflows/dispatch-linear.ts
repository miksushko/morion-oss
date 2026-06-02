/**
 * Linear (array-order) dispatch walker — the L2 default execution
 * path before the Phase 4 DAG runner. Walks `graph_snapshot.stages`
 * in array order, dispatching `mcp_tool_call` stages through the
 * shared executor and inlining `cli_agent` spawn + verdictPolicy
 * routing for the array-order reopen loop.
 *
 * DAG-shape workflows (those carrying `mo_stage` / `reject_sink` /
 * `complete_sink` / `human_gate` nodes) detour through dispatch-dag.ts
 * at the top of the function — the linear walker doesn't need to know
 * about those kinds.
 *
 * Stage 10 of the runner.ts decomposition (ticket
 * 01KRJYYZ3YE57V1PM06ACBDS0T). The cli_agent spawn-and-consume loop
 * (~200 LOC) and verdict-policy routing decision (~50 LOC) live in
 * sibling modules under `dispatch-linear/` — this shell owns
 * pre-flight, the array-order walk, the cli_agent vs mcp_tool_call
 * dispatch, and stage-row + cost + hook book-keeping.
 */

import { isDagWorkflowDefinition } from './parse-linear.js';
import { renderPromptTemplate } from './template.js';
import { runMcpToolStage } from './stage-mcp-tool-call.js';
import { dispatchDag } from './dispatch-dag.js';
import type {
  InternalRunState,
  StageExecutorContext,
  TicketContext,
} from './runner-types.js';
import { runCliAgentStage } from './dispatch-linear/run-cli-agent-stage.js';
import { applyVerdictRouting } from './dispatch-linear/apply-verdict-routing.js';

export async function dispatchLinear(
  ctx: StageExecutorContext,
  state: InternalRunState,
  ticket: TicketContext,
): Promise<void> {
  const { repo } = ctx.deps;
  const initial = repo.getRun(state.runId);
  if (!initial) {
    await ctx.terminate(state, 'failed', 'run row vanished pre-dispatch');
    return;
  }

  // Pre-onRunStart cancel observation. The orchestrator may have
  // flipped `cancel_requested=1` (or marked the row cancelled
  // outright) DURING admission — between row claim and our entry
  // here. Without this check the runner would flip status →
  // running, fire onRunStart (which moves the kanban to `doing`,
  // fighting the user's intent), and only catch the cancel on
  // the first between-stages re-read.
  if (
    initial.cancelRequested ||
    initial.status === 'cancelled' ||
    initial.status === 'failed'
  ) {
    await ctx.terminate(
      state,
      initial.status === 'cancelled'
        ? 'cancelled'
        : initial.status === 'failed'
          ? 'failed'
          : 'cancelled',
      initial.lastError ?? state.cancelReason ?? 'cancel_requested',
    );
    return;
  }

  repo.updateRun(state.runId, { status: 'running' }, ctx.now());
  {
    const fresh = repo.getRun(state.runId);
    if (fresh) await ctx.runHook('onRunStart', state.hooks.onRunStart, fresh);
  }

  // Phase 4 — split dispatch by shape. DAG-shape workflows (mo_stage
  // / reject_sink / complete_sink) walk edges by Mo decisions;
  // linear workflows keep the existing array-order walk.
  if (isDagWorkflowDefinition(initial.graphSnapshot)) {
    await dispatchDag(ctx, state, ticket);
    return;
  }

  const stages = initial.graphSnapshot.stages;
  let i = 0;
  while (i < stages.length) {
    const stage = stages[i]!;
    // Cancel observation between stages. Re-read the row so an
    // out-of-process flag flip is honoured.
    const fresh = repo.getRun(state.runId);
    if (!fresh) {
      await ctx.terminate(state, 'failed', 'run row vanished mid-dispatch');
      return;
    }
    if (fresh.cancelRequested || state.cancelReason) {
      await ctx.terminate(
        state,
        'cancelled',
        state.cancelReason ?? 'cancel_requested',
      );
      return;
    }

    if (stage.kind === 'mcp_tool_call') {
      // Этап 4 — MCP tool stage. Renders argsTemplate strings via
      // the same Mustache renderer cli_agent uses, then dispatches
      // through the injected `mcpToolDispatcher` (factory wires
      // `dispatchMoTool(ALL_TOOLS, ...)`). On success the result
      // lands on `stageOutputs[stage.id].output` so subsequent
      // cli_agent stages can reference it via
      // `{{stages.<id>.output.<key>}}` placeholders.
      //
      // The dispatch loop is a `while`, NOT a `for`, so `continue`
      // here does NOT auto-increment `i`. Bump explicitly before
      // continuing — without this the loop re-executes the same
      // mcp_tool_call stage forever and trips
      // stage_max_attempts_exceeded on the second pass.
      const advance = await runMcpToolStage(ctx, state, stage, ticket);
      if (!advance) return;
      i++;
      continue;
    }
    if (stage.kind !== 'cli_agent') {
      await ctx.terminate(
        state,
        'failed',
        `stage "${stage.id}" has kind="${stage.kind}" — L2 runner accepts cli_agent + mcp_tool_call stages only`,
      );
      return;
    }

    const renderedPrompt = renderPromptTemplate(stage.promptTemplate, {
      ticket,
      stages: state.stageOutputs,
      reopen: state.reopenContext,
    });

    // Compute the next attempt number for this stage id. On a fresh
    // linear advance this is 1; on a reopen-loop re-run it's
    // (latest.attempt + 1). createStage stamps the resulting row.
    const priorAttempt = repo.latestAttemptForStage(state.runId, stage.id);
    const nextAttempt = (priorAttempt?.attempt ?? 0) + 1;

    // Defense in depth: parser already enforces that any
    // verdictPolicy.onReopen.maxAttempts is ≤ target stage
    // maxAttempts, but a hand-crafted definition reaching the
    // runner via a different code path (DB seed, future API)
    // could still violate the cap. Trip loudly before burning
    // adapter budget.
    if (nextAttempt > stage.maxAttempts) {
      await ctx.terminate(
        state,
        'failed',
        `stage_max_attempts_exceeded: stage "${stage.id}" already executed ${
          priorAttempt?.attempt ?? 0
        } times (cap ${stage.maxAttempts})`,
      );
      return;
    }

    const stageRow = repo.createStage(
      {
        runId: state.runId,
        stageIdInGraph: stage.id,
        stageKind: 'cli_agent',
        agentName: stage.agent,
        attempt: nextAttempt,
        initialStatus: 'pending',
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

    // Spawn-and-consume + fallback retry loop lives in the helper
    // module so the per-stage book-keeping (row update, cost rollup,
    // hook firing, verdict routing) stays visible in this file.
    const stageResult = await runCliAgentStage({
      ctx,
      state,
      renderedPrompt: renderedPrompt.output,
      fresh,
      stage,
      stageRowId: stageRow.id,
    });
    const stageOutcome = stageResult.outcome;
    const stageError = stageResult.error;
    const finalCost = stageResult.finalCost;

    repo.updateStage(
      stageRow.id,
      {
        status: stageOutcome,
        activePid: null,
        costUsd: finalCost,
        output:
          stageOutcome === 'done' && state.stageOutputs[stage.id]
            ? state.stageOutputs[stage.id].output
            : null,
        lastError: stageError,
        finishedAt: ctx.now(),
      },
      ctx.now(),
    );

    const runAfterStage = repo.getRun(state.runId);
    if (runAfterStage) {
      repo.updateRun(
        state.runId,
        { totalCostUsd: runAfterStage.totalCostUsd + finalCost },
        ctx.now(),
      );
    }

    // Fire onStageEnd AFTER cost rollup so the hook sees the
    // accumulated `totalCostUsd`, but BEFORE verdict routing /
    // terminate so callers can post a "stage X complete" comment
    // before the next-stage spawn lands its own onStageStart.
    const refreshedStageRow = repo.getStage(stageRow.id);
    const refreshedRun = repo.getRun(state.runId);
    if (refreshedStageRow && refreshedRun) {
      await ctx.runHook('onStageEnd', state.hooks.onStageEnd, {
        run: refreshedRun,
        stage,
        stageRow: refreshedStageRow,
      });
    }

    if (stageOutcome !== 'done') {
      await ctx.terminate(state, stageOutcome, stageError);
      return;
    }

    // Verdict routing for stages that carry a `verdictPolicy` (the
    // review stage of the Default Autocode template, plus any L4
    // template that opts in). Without a policy: linear advance.
    if (stage.verdictPolicy) {
      const routing = applyVerdictRouting(ctx, state, stage, stages, i);
      if (routing.kind === 'terminate') {
        await ctx.terminate(state, 'failed', routing.reason);
        return;
      }
      i = routing.nextIndex;
    } else {
      // No policy on this stage — clear any stale reopen context
      // so a future stage's template can't accidentally see the
      // previous reopen's reason, and advance.
      state.reopenContext = {};
      i++;
    }
  }

  // Every stage reached `done` — run completes.
  await ctx.terminate(state, 'done', null);
}

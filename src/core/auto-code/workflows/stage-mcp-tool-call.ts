/**
 * `mcp_tool_call` stage executor — runs a single MCP tool dispatch as
 * one of the runner's pipeline steps. Extracted out of
 * `WorkflowRunner.runMcpToolStage` so the runner shell shrinks to a
 * composition layer.
 *
 * Stage 4 of the runner.ts decomposition (ticket
 * 01KRJYYZ3YE57V1PM06ACBDS0T).
 *
 * Returns `true` when the loop should advance to the next stage,
 * `false` when the run reached a terminal state inside this method
 * (failed / cancelled). Mirrors the cli_agent dispatch contract but
 * skips:
 *   - adapter spawn / event stream / cost capture (no LLM cost)
 *   - fallbackAgent retry (mcp tools have no fallback semantics)
 *   - verdictPolicy parsing (no verdict on raw tool output; downstream
 *     cli_agent stages can read the result and decide)
 *
 * Args go through `renderPromptTemplate` for any string-shaped value
 * so `{{ticket.body}}` / `{{stages.fix.output}}` references work the
 * same as in cli_agent prompts. Non-string values pass through
 * verbatim.
 */

import { renderPromptTemplate } from './template.js';
import type {
  InternalRunState,
  McpToolDispatchResult,
  StageExecutorContext,
  TicketContext,
} from './runner-types.js';
import type { WorkflowStage } from './types/index.js';

export async function runMcpToolStage(
  ctx: StageExecutorContext,
  state: InternalRunState,
  stage: Extract<WorkflowStage, { kind: 'mcp_tool_call' }>,
  ticket: TicketContext,
): Promise<boolean> {
  const { repo } = ctx.deps;
  const priorAttempt = repo.latestAttemptForStage(state.runId, stage.id);
  const nextAttempt = (priorAttempt?.attempt ?? 0) + 1;
  if (nextAttempt > stage.maxAttempts) {
    await ctx.terminate(
      state,
      'failed',
      `stage_max_attempts_exceeded: stage "${stage.id}" already executed ${
        priorAttempt?.attempt ?? 0
      } times (cap ${stage.maxAttempts})`,
    );
    return false;
  }

  const stageRow = repo.createStage(
    {
      runId: state.runId,
      stageIdInGraph: stage.id,
      stageKind: 'mcp_tool_call',
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

  // Render argsTemplate. String values get the same Mustache
  // pass cli_agent prompts use; non-strings pass through verbatim
  // (numbers, booleans, nested objects).
  const renderCtx = {
    ticket,
    stages: state.stageOutputs,
    reopen: state.reopenContext,
  };
  const renderedArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stage.argsTemplate)) {
    renderedArgs[k] =
      typeof v === 'string' ? renderPromptTemplate(v, renderCtx).output : v;
  }

  let result: McpToolDispatchResult;
  try {
    result = await ctx.mcpToolDispatcher(stage.toolName, renderedArgs);
  } catch (err) {
    result = {
      ok: false,
      error: 'mcp_tool_threw',
      message: (err as Error).message ?? String(err),
    };
  }

  const stageNow = ctx.now();

  // Codex P1b (2026-05-10) — re-check cancel AFTER the dispatcher
  // await. The pre-stage check at the top of the dispatch loop
  // can't see a cancel that flipped while the tool was running,
  // and a successful last-stage MCP call would otherwise close
  // the run as `done` against the user's intent. Mark the stage
  // cancelled + terminate the run cleanly instead.
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
    return false;
  }

  if (result.ok) {
    // Persist the data envelope on the stage row + in-memory
    // outputs so subsequent stages can reference
    // `{{stages.<id>.output.data}}` / `{{stages.<id>.output}}`.
    // Codex P2c (2026-05-10) — roll the optional `costUsd` from
    // the dispatch envelope into the stage row + run total so
    // mo_ask / mo_get_context spend appears in the run's
    // accumulated cost (used by the orchestrator's "complete"
    // comment + future budget caps).
    const outputObj = { data: result.data };
    const stageCost =
      typeof result.costUsd === 'number' && result.costUsd >= 0
        ? result.costUsd
        : 0;
    repo.updateStage(
      stageRow.id,
      {
        status: 'done',
        finishedAt: stageNow,
        output: outputObj,
        costUsd: stageCost,
      },
      stageNow,
    );
    if (stageCost > 0) {
      const runRow = repo.getRun(state.runId);
      if (runRow) {
        repo.updateRun(
          state.runId,
          { totalCostUsd: runRow.totalCostUsd + stageCost },
          stageNow,
        );
      }
    }
    state.stageOutputs[stage.id] = { output: outputObj };
    await ctx.fireStageEndHook(state, stage);
    return true;
  }

  // Failure path. Stage row → failed; run → failed via terminate.
  // Codex P2a (2026-05-10) — fire onStageEnd before the run-level
  // terminate so callers (e.g. WorkflowOrchestrator) see the same
  // stage-row lifecycle they get for failed cli_agent stages.
  const errorLine = `mcp_tool_failed:${result.error}${
    result.message ? `: ${result.message}` : ''
  }`;
  repo.updateStage(
    stageRow.id,
    { status: 'failed', finishedAt: stageNow, lastError: errorLine },
    stageNow,
  );
  await ctx.fireStageEndHook(state, stage);
  await ctx.terminate(state, 'failed', errorLine);
  return false;
}

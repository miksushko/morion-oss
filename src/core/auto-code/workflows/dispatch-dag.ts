/**
 * Phase 4 — DAG-shape dispatch walker.
 *
 * Walks `edges` from the entry stage (the `mo_stage` with
 * `isStart: true` per Editor Model v2 spec — Morion note
 * 01KRAQWPXR5AYTFVF6J12TYHJ1) following Mo decisions on `mo_stage`
 * nodes and the single `success` edge on `cli_agent` / `mcp_tool_call`
 * nodes. Terminates on `reject_sink` (run.status = 'failed' with
 * `rejected_by_workflow:` lastError prefix) or `complete_sink`
 * (run.status = 'done').
 *
 * Co-exists with the linear `dispatch()` walk in runner.ts:
 * pure-linear workflows continue on the array-order path (cheaper +
 * load-bearing for the L2 fallback during Phase 4 rollout).
 *
 * Sink-rendered comment text lives on the sink stage row's
 * `output.comment` so orchestrator hooks (onStageEnd) can post it to
 * the ticket. The walker doesn't touch the comments repository
 * directly — runner stays runtime-agnostic per the L1 contract.
 *
 * Stage 9 of the runner.ts decomposition (ticket
 * 01KRJYYZ3YE57V1PM06ACBDS0T).
 */

import { findOutboundByLabel } from './runner-helpers.js';
import { runMcpToolStage } from './stage-mcp-tool-call.js';
import { runSinkStage } from './stage-sink.js';
import { runHumanGateStage } from './stage-human-gate.js';
import { runMoStageNode } from './stage-mo-decision.js';
import { runCliAgentStage } from './stage-cli-agent.js';
import type {
  InternalRunState,
  StageExecutorContext,
  TicketContext,
} from './runner-types.js';
import type { WorkflowStage } from './types/index.js';

export async function dispatchDag(
  ctx: StageExecutorContext,
  state: InternalRunState,
  ticket: TicketContext,
  /** Phase 5 — when set, the walk starts here instead of the
   *  `isStart` mo_stage. Used by `resumeFromHumanGate` to re-enter
   *  the loop right at the human_gate's outbound edge target after
   *  the user replied. Null/undefined = fresh dispatch. */
  entryStageIdOverride?: string,
): Promise<void> {
  const { repo } = ctx.deps;
  const initial = repo.getRun(state.runId);
  if (!initial) {
    await ctx.terminate(state, 'failed', 'run row vanished pre-dag-dispatch');
    return;
  }
  const stages = initial.graphSnapshot.stages;
  const edges = initial.graphSnapshot.edges;
  const stageById = new Map<string, WorkflowStage>(
    stages.map((s) => [s.id, s]),
  );

  // Entry — resume override > mo_stage.isStart=true > stages[0]
  // (defensive — schema enforces exactly one isStart on v2 graphs).
  const start = entryStageIdOverride
    ? stageById.get(entryStageIdOverride)
    : (stages.find((s) => s.kind === 'mo_stage' && s.isStart === true) ??
      stages[0]);
  if (!start) {
    await ctx.terminate(state, 'failed', 'dag_dispatch: no entry stage');
    return;
  }

  let currentId: string | null = start.id;
  // Defensive walk bound — each stage may be revisited up to its
  // maxAttempts (reopen loop), but pathological graphs (mo_stage
  // routing in a tight cycle) shouldn't burn unbounded LLM calls.
  // Cap total visits = stages.length * 8 (covers 3 reopen passes +
  // generous margin for multi-cycle decision graphs).
  const visitCap = Math.max(stages.length * 8, 32);
  let visits = 0;
  while (currentId !== null) {
    visits++;
    if (visits > visitCap) {
      await ctx.terminate(
        state,
        'failed',
        `dag_dispatch_visit_cap_exceeded: walk visited ${visits} stages without reaching a terminal sink — likely a routing cycle without a sink-reachable branch`,
      );
      return;
    }
    const stage: WorkflowStage | undefined = stageById.get(currentId);
    if (!stage) {
      await ctx.terminate(
        state,
        'failed',
        `dag_dispatch: edge points to unknown stage id "${currentId}"`,
      );
      return;
    }
    // Cancel observation between stages.
    const fresh = repo.getRun(state.runId);
    if (!fresh) {
      await ctx.terminate(
        state,
        'failed',
        'run row vanished mid-dag-dispatch',
      );
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

    if (stage.kind === 'mo_stage' || stage.kind === 'mo_router') {
      const result = await runMoStageNode(ctx, state, stage, ticket, edges);
      if (result.kind === 'terminated') return;
      currentId = result.nextStageId;
      continue;
    }
    if (stage.kind === 'cli_agent') {
      const result = await runCliAgentStage(ctx, state, stage, ticket);
      if (result.kind === 'terminated') return;
      currentId = findOutboundByLabel(edges, stage.id, 'success');
      if (currentId === null) {
        // No outbound edge — treat as graceful end (legacy linear
        // single-stage shape).
        await ctx.terminate(state, 'done', null);
        return;
      }
      // Bug fix (ticket 01KRMA2WWK65K42MD3Q34GE5YJ, 2026-05-15):
      // cli_agent has fully consumed `state.reopenContext` via its
      // prompt template at this point. Clear it before advancing so
      // the next mo_stage doesn't see a stale `userReply` / `reason`
      // from a prior loop-back iteration. Without this, a workflow
      // with a re-open edge mo_after_fix → cli_agent → mo_after_fix
      // would feed Mo the SAME user reply on every subsequent
      // iteration of the loop, locking the dispatcher into infinite
      // re-open until stage_max_attempts_exceeded.
      state.reopenContext = {};
      continue;
    }
    if (stage.kind === 'mcp_tool_call') {
      const advance = await runMcpToolStage(ctx, state, stage, ticket);
      if (!advance) return;
      currentId = findOutboundByLabel(edges, stage.id, 'success');
      if (currentId === null) {
        await ctx.terminate(state, 'done', null);
        return;
      }
      continue;
    }
    if (stage.kind === 'reject_sink' || stage.kind === 'eject') {
      await runSinkStage(ctx, state, stage, ticket, 'reject');
      return;
    }
    if (stage.kind === 'complete_sink') {
      await runSinkStage(ctx, state, stage, ticket, 'complete');
      return;
    }
    if (stage.kind === 'human_gate') {
      // Phase 5 MVP — pause the run, open an Ask Mo session via the
      // injected handler, persist the link in workflow_runs. The
      // walk exits without calling terminate; the run row remains
      // alive in `paused_ask_user` state until the chat route's
      // resume hook fires runner.resumeFromHumanGate().
      const result = await runHumanGateStage(ctx, state, stage, ticket, edges);
      if (result.kind === 'paused') return; // exit walk; run is alive + paused
      if (result.kind === 'terminated') return;
      // Defensive: shouldn't reach here on a normal MVP path
      // (human_gate always pauses on first visit). Leaving the
      // branch makes the type narrow cleanly.
      currentId = result.nextStageId;
      continue;
    }
    // branch / unknown kinds — reserved.
    await ctx.terminate(
      state,
      'failed',
      `dag_dispatch: stage "${stage.id}" has kind="${stage.kind}" which has no DAG runtime path`,
    );
    return;
  }

  // Fell out of the loop without a terminal sink — graphs whose
  // edges hit a dead-end. Schema reachability check makes this
  // impossible for well-formed v2 graphs but tests may inject
  // malformed snapshots.
  await ctx.terminate(
    state,
    'failed',
    'dag_dispatch: walk reached an end without a terminal sink',
  );
}

/**
 * `human_gate` stage executor (Phase 5).
 *
 * The runner owns the state-machine work (create stage row, find
 * outbound edge, persist pause status); the injected
 * `humanGateHandler` owns external IO (create Ask Mo session + post
 * Mo's question + post a visible ticket comment). The walk exits
 * cleanly with `{kind:'paused'}` — the dispatch loop's caller
 * (`dispatchDag`) returns without calling `terminate`, so the run row
 * remains alive in `paused_ask_user` until the chat route resumes it.
 *
 * Failure paths terminate the run with a concrete envelope so the
 * user gets actionable feedback instead of a silently-stuck row:
 *   - missing outbound edge → `human_gate_no_outbound_edge`
 *   - handler refused (handler not wired, session create failed) →
 *     `human_gate_handler_failed: <reason>`
 *   - pauseForHumanGate update raced (run already terminal) →
 *     `human_gate_race_lost: ...`
 *
 * Stage 6 of the runner.ts decomposition (ticket
 * 01KRJYYZ3YE57V1PM06ACBDS0T).
 */

import {
  humanGateGuidance,
  type WorkflowEdge,
  type WorkflowStage,
} from './types/index.js';
import type {
  InternalRunState,
  StageExecutorContext,
  TicketContext,
} from './runner-types.js';

export type HumanGateOutcome =
  | { kind: 'paused' }
  | { kind: 'terminated' }
  | { kind: 'advance'; nextStageId: string };

export async function runHumanGateStage(
  ctx: StageExecutorContext,
  state: InternalRunState,
  stage: Extract<WorkflowStage, { kind: 'human_gate' }>,
  ticket: TicketContext,
  edges: readonly WorkflowEdge[],
): Promise<HumanGateOutcome> {
  const { repo } = ctx.deps;
  // 1. Find outbound edge — schema's v2 superRefine guarantees
  //    exactly one outbound for any human_gate. The label is open
  //    (any string; spec recommends ""). Catch the missing case
  //    explicitly so a hand-edited row doesn't crash.
  const outboundTargetId = (() => {
    for (const e of edges) {
      if (e.from === stage.id) return e.to;
    }
    return null;
  })();
  if (outboundTargetId === null) {
    await ctx.terminate(
      state,
      'failed',
      `human_gate_no_outbound_edge: stage "${stage.id}" has no outbound edge — user's reply has nowhere to resume to`,
    );
    return { kind: 'terminated' };
  }

  // 2. Create the stage row (status='running'; flips to 'done' on
  //    resume after the user reply lands). Per-stage attempt count
  //    tracks repeated pauses (a workflow might re-ask via a 2nd
  //    visit to the same human_gate after a loop).
  const priorAttempt = repo.latestAttemptForStage(state.runId, stage.id);
  const nextAttempt = (priorAttempt?.attempt ?? 0) + 1;
  const stageRow = repo.createStage(
    {
      runId: state.runId,
      stageIdInGraph: stage.id,
      stageKind: 'human_gate',
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

  // 3. External effects via the injected handler — creates the Ask
  //    Mo session, posts Mo's question as the opening assistant
  //    message, posts the visible footprint comment on the ticket.
  const run = repo.getRun(state.runId);
  // Phase 6 V2: pass the workflow author's `guidance` (optional)
  // through to the handler. The handler is the one that calls Mo
  // to compose the actual chat opening message from full context;
  // `guidance` is just a hint about WHAT to ask. Legacy `prompt`
  // is folded into guidance via the schema transform.
  const handlerResult = await ctx.humanGateHandler({
    runId: state.runId,
    folderId: run?.folderId ?? '',
    ticketId: run?.ticketId ?? ticket.id,
    humanGateStageId: stage.id,
    guidance: humanGateGuidance(stage),
    ticketTitle: ticket.title,
  });
  if (!handlerResult.ok) {
    repo.updateStage(
      stageRow.id,
      {
        status: 'failed',
        finishedAt: ctx.now(),
        lastError: handlerResult.reason,
      },
      ctx.now(),
    );
    await ctx.terminate(
      state,
      'failed',
      `human_gate_handler_failed: ${handlerResult.reason}`,
    );
    return { kind: 'terminated' };
  }

  // 4. Atomic flip of the run row to paused_ask_user + link the
  //    chat session. The repo method guards on
  //    `status IN ('running','pending') AND cancel_requested = 0`
  //    so a concurrent cancel wins cleanly.
  const flipped = repo.pauseForHumanGate(
    {
      runId: state.runId,
      sessionId: handlerResult.sessionId,
      humanGateStageId: stage.id,
    },
    ctx.now(),
  );
  if (!flipped) {
    // Concurrent cancel won. Mark stage failed and bail.
    repo.updateStage(
      stageRow.id,
      {
        status: 'failed',
        finishedAt: ctx.now(),
        lastError: 'human_gate_race_lost: run cancelled mid-pause',
      },
      ctx.now(),
    );
    // Don't call terminate again — the cancel path already did
    // (or is about to). Just exit the walk.
    return { kind: 'terminated' };
  }
  // Persist the sessionId on the stage row so the drawer surface
  // can link "Open chat" without an extra DB lookup.
  repo.updateStage(
    stageRow.id,
    {
      sessionId: handlerResult.sessionId,
      output: {
        sessionId: handlerResult.sessionId,
        guidance: humanGateGuidance(stage),
        resumeTargetStageId: outboundTargetId,
      },
    },
    ctx.now(),
  );

  // 5. onStageEnd hook — gives the orchestrator a chance to post
  //    extra Mo footprint comments. The stage status stays 'running'
  //    while paused; resume flips it to 'done'.
  {
    const freshStage = repo.getStage(stageRow.id);
    const freshRun = repo.getRun(state.runId);
    if (freshStage && freshRun) {
      await ctx.runHook('onStageEnd', state.hooks.onStageEnd, {
        run: freshRun,
        stage,
        stageRow: freshStage,
      });
    }
  }

  return { kind: 'paused' };
}

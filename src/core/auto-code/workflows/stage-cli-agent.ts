/**
 * `cli_agent` stage executor used by the DAG dispatch path. Wraps the
 * same adapter-spawn + fallback loop the linear dispatcher uses but
 * returns a `{kind:'terminated'|'advance'}` envelope so the DAG walker
 * can drive the next-stage lookup itself.
 *
 * Mirrors the linear path's behaviour for:
 *   - pre-spawn budget guard check
 *   - pre-spawn + post-assignment cancel observation
 *   - Phase 6 V2 resume-mode session re-attach (Pi/Claude/Opencode)
 *     with Codex AgentResumeUnsupportedError fallback to fresh spawn
 *   - authoritative session id capture from session_start event
 *   - fallback agent retry on recoverable errors / Ink crash
 *   - max attempts cap
 *
 * Linear path's verdictPolicy routing is intentionally NOT applied
 * here — DAG workflows route via `mo_stage` decisions, not via verdict
 * envelopes baked into cli_agent prompts.
 *
 * Stage 8 of the runner.ts decomposition (ticket
 * 01KRJYYZ3YE57V1PM06ACBDS0T).
 */

import type { AgentHandle } from '../harness/adapter.js';
import { AgentResumeUnsupportedError } from '../harness/adapter.js';
import type { CliAgentEvent } from '../harness/events.js';
import { isResult, isError } from '../harness/events.js';
import { renderPromptTemplate } from './template.js';
import { realWorktreeDiffCapture } from './worktree-diff.js';
import {
  consumeUntilTerminal,
  isRecoverableErrorKind,
} from './runner-helpers.js';
import type {
  BudgetGuardContext,
  InternalRunState,
  StageExecutorContext,
  TicketContext,
} from './runner-types.js';
import type { CliAgentName, WorkflowStage } from './types/index.js';

export type CliAgentOutcome = { kind: 'terminated' } | { kind: 'advance' };

export async function runCliAgentStage(
  ctx: StageExecutorContext,
  state: InternalRunState,
  stage: Extract<WorkflowStage, { kind: 'cli_agent' }>,
  ticket: TicketContext,
): Promise<CliAgentOutcome> {
  const { repo } = ctx.deps;
  const fresh = repo.getRun(state.runId);
  if (!fresh) {
    await ctx.terminate(state, 'failed', 'run row vanished pre-cli_agent');
    return { kind: 'terminated' };
  }

  // Deterministic handoff ("Mo = router, not narrator"): snapshot the
  // pre-stage HEAD so the post-stage diff captures exactly what THIS
  // stage changed, committed or not. Best-effort — null on non-repo
  // paths (unit tests, exotic setups) and the fields are simply omitted.
  const diffCapture = ctx.deps.worktreeDiff ?? realWorktreeDiffCapture;
  const preStageSha = await diffCapture.headSha(fresh.worktreePath);

  const renderedPrompt = renderPromptTemplate(stage.promptTemplate, {
    ticket,
    stages: state.stageOutputs,
    reopen: state.reopenContext,
  });

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
    return { kind: 'terminated' };
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

  let stageOutcome: 'done' | 'failed' | 'cancelled' = 'failed';
  let stageError: string | null = null;
  let finalCost = 0;
  let currentAgent: CliAgentName = stage.agent;
  let triedFallback = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    stageOutcome = 'failed';
    stageError = null;
    finalCost = 0;
    let recoverableError = false;

    const abortController = new AbortController();
    try {
      if (ctx.isCancelled(state)) {
        abortController.abort();
        stageOutcome = 'cancelled';
        stageError = state.cancelReason ?? 'cancel_requested';
        throw new Error('__pre_spawn_cancel__');
      }
      const budgetCtx: BudgetGuardContext = {
        runId: state.runId,
        folderId: fresh.folderId,
        ticketId: fresh.ticketId,
        stageId: stage.id,
        agent: currentAgent,
        stageMaxBudgetUsd: stage.maxBudgetUsd,
        runTotalCostUsd: fresh.totalCostUsd,
      };
      const verdict = await Promise.resolve(ctx.budgetGuard.check(budgetCtx));
      if (!verdict.allow) {
        stageOutcome = 'failed';
        stageError = `budget_guard_denied: ${verdict.reason}`;
        throw new Error('__pre_spawn_budget_denied__');
      }
      const adapter = ctx.deps.adapterFactory(currentAgent);
      const isFallbackIter =
        triedFallback && currentAgent === stage.fallbackAgent;
      const v2Provider = isFallbackIter
        ? stage.fallbackProvider ?? stage.provider ?? undefined
        : stage.provider ?? undefined;
      const v2Model = isFallbackIter
        ? stage.fallbackModel ?? stage.model ?? undefined
        : stage.model ?? undefined;
      const v2Level = isFallbackIter
        ? stage.fallbackLevel ?? stage.level ?? undefined
        : stage.level ?? undefined;
      const v2Instruction = isFallbackIter
        ? stage.fallbackAgentInstruction || stage.agentInstruction
        : stage.agentInstruction;
      const promptWithInstruction =
        v2Instruction && v2Instruction.length > 0
          ? `${v2Instruction}\n\n${renderedPrompt.output}`
          : renderedPrompt.output;
      // Phase 6 V2 hotfix (2026-05-13) — Bug #2: resume the prior
      // session when re-entering this stage on a loop-back. Pi /
      // Claude / Opencode adapters honour `resumeSessionId` by
      // spawning their CLI in resume-mode against that prior id;
      // the `prompt` becomes the next user turn injected into the
      // existing conversation rather than the opening message of a
      // fresh session — so the agent retains memory of its prior
      // questions and the user reply lands naturally.
      // Codex 0.1.x has no --resume flag and throws
      // AgentResumeUnsupportedError → caller catches and retries
      // with a fresh spawn (the prompt already carries
      // {{reopen.reason}} from Bug #1's fix, so codex still sees
      // the user's answer in text form even on fresh).
      const priorSessionForResume =
        nextAttempt > 1 && !triedFallback
          ? priorAttempt?.sessionId ?? undefined
          : undefined;
      let handle: AgentHandle;
      try {
        handle = await adapter.spawn({
          prompt: promptWithInstruction,
          cwd: fresh.worktreePath,
          allowedTools: stage.allowedTools,
          maxBudgetUsd: stage.maxBudgetUsd ?? undefined,
          transcriptDir: ctx.deps.transcriptDir,
          signal: abortController.signal,
          ...(priorSessionForResume
            ? { resumeSessionId: priorSessionForResume }
            : {}),
          ...(v2Provider ? { provider: v2Provider } : {}),
          ...(v2Model ? { model: v2Model } : {}),
          ...(v2Level ? { level: v2Level } : {}),
        });
      } catch (err) {
        if (
          err instanceof AgentResumeUnsupportedError &&
          priorSessionForResume
        ) {
          // Adapter doesn't support resume — retry as a fresh
          // spawn. The user's reply is still threaded via
          // {{reopen.reason}} in promptWithInstruction.
          handle = await adapter.spawn({
            prompt: promptWithInstruction,
            cwd: fresh.worktreePath,
            allowedTools: stage.allowedTools,
            maxBudgetUsd: stage.maxBudgetUsd ?? undefined,
            transcriptDir: ctx.deps.transcriptDir,
            signal: abortController.signal,
            ...(v2Provider ? { provider: v2Provider } : {}),
            ...(v2Model ? { model: v2Model } : {}),
            ...(v2Level ? { level: v2Level } : {}),
          });
        } else {
          throw err;
        }
      }
      state.currentAdapterHandle = handle;
      if (ctx.isCancelled(state)) {
        await handle.cancel(state.cancelReason ?? 'parent_handle_cancel');
      }
      const transcriptPath = `${ctx.deps.transcriptDir}/${handle.sessionId}.jsonl`;
      repo.updateStage(
        stageRow.id,
        {
          status: 'running',
          agentName: currentAgent,
          sessionId: handle.sessionId,
          transcriptPath,
          activePid: handle.pid,
        },
        ctx.now(),
      );
      // Capture the LATEST authoritative session id from the
      // event stream (Pi/Opencode emit one mid-stream that differs
      // from the caller-side UUID; that authoritative id is the
      // ONLY value the CLI accepts on `--session` resume). Update
      // the persisted stage row's sessionId so attempt N+1's
      // `priorAttempt.sessionId` lookup returns the resumable id.
      let authoritativeSessionId: string | null = null;
      const terminal = await consumeUntilTerminal(handle.events, (sid) => {
        if (sid && sid !== handle.sessionId) {
          authoritativeSessionId = sid;
        }
      });
      if (authoritativeSessionId !== null) {
        repo.updateStage(
          stageRow.id,
          { sessionId: authoritativeSessionId },
          ctx.now(),
        );
      }
      await handle.exited;
      if (isResult(terminal)) {
        if (terminal.terminalReason === 'budget') {
          stageOutcome = 'failed';
          stageError = `budget_exhausted: stage hit its per-stage budget cap at $${terminal.costUsd.toFixed(4)} before completing`;
          finalCost = terminal.costUsd;
        } else {
          stageOutcome = 'done';
          finalCost = terminal.costUsd;
          state.stageOutputs[stage.id] = {
            output: {
              summary: terminal.summary,
              terminalReason: terminal.terminalReason,
              exitCode: terminal.exitCode,
            },
          };
        }
      } else if (isError(terminal)) {
        stageOutcome =
          terminal.errorKind === 'killed' ? 'cancelled' : 'failed';
        stageError = `${terminal.errorKind}: ${terminal.message}`;
        recoverableError = terminal.recoverable === true;
      } else {
        stageOutcome = 'failed';
        stageError = `non-terminal event escaped consumeUntilTerminal: ${(terminal as CliAgentEvent).kind}`;
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message === '__pre_spawn_cancel__' ||
          err.message === '__pre_spawn_budget_denied__')
      ) {
        // already populated.
      } else {
        stageOutcome = 'failed';
        stageError =
          err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (
          err &&
          typeof err === 'object' &&
          'errorKind' in err &&
          isRecoverableErrorKind((err as { errorKind?: unknown }).errorKind)
        ) {
          recoverableError = true;
        }
      }
    } finally {
      state.currentAdapterHandle = null;
    }

    if (
      stageOutcome === 'failed' &&
      recoverableError &&
      stage.fallbackAgent &&
      !triedFallback &&
      stage.fallbackAgent !== currentAgent
    ) {
      triedFallback = true;
      currentAgent = stage.fallbackAgent;
      continue;
    }
    break;
  }

  // Enrich the completed stage's output with what actually changed in
  // the worktree — facts for downstream templates
  // ({{stages.<id>.output.diffstat}} / .filesChanged), persisted with
  // the rest of output_json below.
  if (stageOutcome === 'done' && state.stageOutputs[stage.id]) {
    const diff = await diffCapture.diffSince(fresh.worktreePath, preStageSha);
    if (diff) {
      state.stageOutputs[stage.id] = {
        output: {
          ...(state.stageOutputs[stage.id].output as Record<string, unknown>),
          diffstat: diff.diffstat,
          filesChanged: diff.filesChanged,
        },
      };
    }
  }

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
    return { kind: 'terminated' };
  }
  return { kind: 'advance' };
}

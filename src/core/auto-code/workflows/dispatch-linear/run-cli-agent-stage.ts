import type { AgentHandle } from '../../harness/adapter.js';
import type { CliAgentEvent } from '../../harness/events.js';
import { isError, isResult } from '../../harness/events.js';
import {
  consumeUntilTerminal,
  isRecoverableErrorKind,
} from '../runner-helpers.js';
import type {
  BudgetGuardContext,
  InternalRunState,
  StageExecutorContext,
} from '../runner-types.js';
import type { CliAgentName } from '../types/index.js';

/**
 * Outcome of one cli_agent stage attempt (including its optional
 * fallback retry). The shell uses these fields to update the stage
 * row, roll up cost, fire `onStageEnd`, and decide whether to
 * continue, terminate, or apply verdict routing.
 */
export interface CliAgentStageOutcome {
  outcome: 'done' | 'failed' | 'cancelled';
  error: string | null;
  finalCost: number;
  /** Resolved adapter on the wire for the FINAL attempt (primary or
   *  fallback). The shell writes this into the stage row so the
   *  transcript path resolves correctly per-agent. */
  currentAgent: CliAgentName;
}

interface RunCliAgentStageDeps {
  ctx: StageExecutorContext;
  state: InternalRunState;
  /** Already-rendered prompt body (without `agentInstruction` prefix). */
  renderedPrompt: string;
  /** Already-claimed run row at the start of the stage. Subset of
   *  `WorkflowRunRow` we actually consume — caller passes the row verbatim. */
  fresh: {
    id: string;
    folderId: string;
    ticketId: string;
    totalCostUsd: number;
    worktreePath: string;
  };
  /** Stage definition from the workflow graph. */
  stage: {
    id: string;
    agent: CliAgentName;
    fallbackAgent?: CliAgentName;
    allowedTools?: string[];
    maxBudgetUsd?: number | null;
    provider?: string | null;
    model?: string | null;
    level?: string | null;
    agentInstruction?: string;
    fallbackProvider?: string | null;
    fallbackModel?: string | null;
    fallbackLevel?: string | null;
    fallbackAgentInstruction?: string;
  };
  stageRowId: string;
}

/**
 * Spawn-and-consume loop for ONE cli_agent stage. Iterates at most
 * twice: first attempt with `stage.agent`, then a single retry with
 * `stage.fallbackAgent` on a recoverable terminal error
 * (codex_ink_crash is the canonical case).
 *
 * Owns:
 *   - pre-spawn cancel + budget gates
 *   - adapter spawn with v2 provider/model/level overrides (primary
 *     vs. fallback)
 *   - consumeUntilTerminal + authoritative session-id capture
 *   - terminal-event → outcome translation (budget vs done vs
 *     killed-cancel vs error)
 *   - fallback retry decision (recoverable + has fallback + single-
 *     shot)
 *
 * Does NOT own: stage row creation/update, hook firing, cost rollup,
 * verdict routing — those stay in the shell so the inter-stage
 * orchestration is visible at one glance.
 */
export async function runCliAgentStage(
  deps: RunCliAgentStageDeps,
): Promise<CliAgentStageOutcome> {
  const { ctx, state, renderedPrompt, fresh, stage, stageRowId } = deps;
  const repo = ctx.deps.repo;

  let stageOutcome: 'done' | 'failed' | 'cancelled' = 'failed';
  let stageError: string | null = null;
  let finalCost = 0;
  // Fallback retry tracking. If the primary agent fails
  // recoverably (codex Ink crash is the canonical case) AND
  // stage.fallbackAgent is set, the runner re-spawns the SAME
  // stage row exactly once with the fallback agent. Single-shot
  // — a recoverable failure on the fallback ends the stage.
  let currentAgent: CliAgentName = stage.agent;
  let triedFallback = false;

  // Spawn-and-consume loop. Iterates at most twice for a stage
  // with `fallbackAgent`: first attempt with `stage.agent`, then
  // a single retry with `stage.fallbackAgent` on a recoverable
  // terminal error. `currentAgent` carries which agent is on the
  // wire for THIS iteration.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Reset per-iteration outcome state (the stage row is shared
    // across fallback iterations — a transparent retry doesn't
    // create a new attempt row).
    stageOutcome = 'failed';
    stageError = null;
    finalCost = 0;
    let recoverableError = false;

    // AbortController so a cancel() that races BEFORE adapter.spawn
    // resolves can still propagate to the spawn handle. Adapters
    // that honour SpawnOptions.signal will reject spawn or terminate
    // the freshly-spawned child.
    const abortController = new AbortController();
    try {
      // Pre-spawn cancel check — flag may have been set between the
      // outer between-stages check and now (very tight window, but
      // real if cancel() runs from another tick of the event loop).
      if (ctx.isCancelled(state)) {
        abortController.abort();
        stageOutcome = 'cancelled';
        stageError = state.cancelReason ?? 'cancel_requested';
        throw new Error('__pre_spawn_cancel__');
      }
      // Pre-spawn budget gate. The structural seam — default
      // implementation (PASS_THROUGH_BUDGET_GUARD) always allows;
      // the real workspace-wide auto-code monthly cap is wired in
      // L2.T8 once `mo_spend_ledger` is fixed.
      const budgetCtx: BudgetGuardContext = {
        runId: state.runId,
        folderId: fresh.folderId,
        ticketId: fresh.ticketId,
        stageId: stage.id,
        agent: currentAgent,
        stageMaxBudgetUsd: stage.maxBudgetUsd ?? null,
        runTotalCostUsd: fresh.totalCostUsd,
      };
      const verdict = await Promise.resolve(ctx.budgetGuard.check(budgetCtx));
      if (!verdict.allow) {
        stageOutcome = 'failed';
        stageError = `budget_guard_denied: ${verdict.reason}`;
        throw new Error('__pre_spawn_budget_denied__');
      }
      const adapter = ctx.deps.adapterFactory(currentAgent);
      // Plumb v2 cli_agent fields (Phase 4). On the fallback
      // iteration we prefer fallback* overrides when present and
      // otherwise inherit the primary's settings.
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
          ? `${v2Instruction}\n\n${renderedPrompt}`
          : renderedPrompt;
      const handle: AgentHandle = await adapter.spawn({
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
      state.currentAdapterHandle = handle;

      // Post-assignment re-check. cancel() may have run while
      // spawn was awaiting — in that path the flag was set but
      // currentAdapterHandle was still null when cancel observed,
      // so the handle was not signalled. Catch up here BEFORE
      // consuming events.
      if (ctx.isCancelled(state)) {
        await handle.cancel(state.cancelReason ?? 'parent_handle_cancel');
      }

      const transcriptPath = `${ctx.deps.transcriptDir}/${handle.sessionId}.jsonl`;
      repo.updateStage(
        stageRowId,
        {
          status: 'running',
          agentName: currentAgent,
          sessionId: handle.sessionId,
          transcriptPath,
          activePid: handle.pid,
        },
        ctx.now(),
      );

      // Mirror DAG path's authoritative-session capture so Pi /
      // Opencode get the same resume-id treatment if linear flow
      // ever uses them. Cheap insurance.
      let authoritativeSessionIdLin: string | null = null;
      const terminal = await consumeUntilTerminal(handle.events, (sid) => {
        if (sid && sid !== handle.sessionId) {
          authoritativeSessionIdLin = sid;
        }
      });
      if (authoritativeSessionIdLin !== null) {
        repo.updateStage(
          stageRowId,
          { sessionId: authoritativeSessionIdLin },
          ctx.now(),
        );
      }
      await handle.exited;

      if (isResult(terminal)) {
        // Budget exhaustion is NOT a clean done. The L1 invariant
        // distinguishes `terminalReason: 'budget'` from `'completed'`
        // precisely so the runner can treat the stage as failure
        // (work may be incomplete; review of a half-done diff is
        // worse than a clear failure surfaced to the user).
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
        // stageOutcome/stageError already populated above. Fall through.
      } else {
        stageOutcome = 'failed';
        stageError =
          err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        // Recoverable spawn-time errors must trip the fallback
        // retry too — without this, codex_ink_crash that surfaces
        // as a thrown AgentBinaryNotFoundError (codex CLI absent
        // entirely) AND required_package_missing skip the
        // fallbackAgent retry that the same error would activate
        // when reported as a terminal ErrorEvent. Mirrors the
        // legacy orchestrator's "missing codex → claude-fallback"
        // behaviour.
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

    // Decide: retry with fallback agent, or break out of the loop.
    // Conditions ALL required:
    //   - stage failed (not cancelled, not done)
    //   - the terminal event was a RECOVERABLE error (codex_ink_crash
    //     is the canonical case)
    //   - stage has a fallbackAgent configured
    //   - we haven't already used the fallback (single-shot retry)
    //   - the fallback isn't the same as the agent we just tried
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

  return { outcome: stageOutcome, error: stageError, finalCost, currentAgent };
}

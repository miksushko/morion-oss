/**
 * Workflow orchestrator — runner hooks composition.
 *
 * Extracted from src/core/auto-code/workflows/workflow-orchestrator.ts
 * on 2026-05-16. Builds the closure of onRunStart / onStageStart /
 * onStageEnd / onRunTerminal that drives the user-facing side effects
 * of an auto-code run (kanban moves, Mo footprint comments, trunk-
 * guard snapshot + revert, escalation chat session opening, etc.).
 */
import {
  REJECTED_BY_WORKFLOW_PREFIX,
  type RunnerHooks,
} from '../runner.js';
import { AUTO_CODE_ACTOR, AUTO_CODE_PAUSED_TAG } from '../../actor-constants.js';
import {
  auditTrunkAfterRun,
  revertLeakedFiles,
  snapshotTrunkState,
} from '../../trunk-guard.js';
import type { WorkflowOrchestrator as WO } from '../workflow-orchestrator.js';
import {
  capitalise,
  describeAgentChain,
  findReopenTargetStageId,
  stageDescriptor,
} from './helpers.js';
import { openEscalationChat } from './escalation.js';
import {
  formatFailureComment,
  humanizeFailureReason,
} from './failure-humanizer.js';

export function buildHooks(orch: WO, taskId: string, worktreeName: string): RunnerHooks {
  const post = (body: string): void => {
    try {
      orch.deps.comments.create(taskId, body, AUTO_CODE_ACTOR, null);
    } catch (err) {
      // Comments are advisory — never escalate to run failure.
      console.error('[workflow-orchestrator] post comment failed:', err);
    }
  };
  const moveKanban = (status: 'doing' | 'review' | 'done' | 'backlog'): void => {
    try {
      orch.deps.notes.moveToKanban(taskId, status, null, AUTO_CODE_ACTOR);
    } catch (err) {
      console.error(`[workflow-orchestrator] kanban move → ${status} failed:`, err);
    }
  };
  const tagPaused = (): void => {
    try {
      const note = orch.deps.notes.getById(taskId);
      if (!note) return;
      if (note.tags?.includes(AUTO_CODE_PAUSED_TAG)) return;
      orch.deps.notes.update(
        taskId,
        { tags: [...(note.tags ?? []), AUTO_CODE_PAUSED_TAG] },
        AUTO_CODE_ACTOR,
      );
    } catch (err) {
      console.error('[workflow-orchestrator] tag auto-code-paused failed:', err);
    }
  };
  /** Strip `auto-code-paused` when a fresh run starts. Re-drag to
   *  todo = user wants another attempt; the paused tag was a hint
   *  from a PRIOR failure that no longer applies. Without this,
   *  the tag stayed on the ticket AND showed up in Mo's recent-
   *  comments context, biasing the next mo_start toward another
   *  "reject — ticket is paused" decision even after the user
   *  fixed the underlying config / re-edited the spec. */
  const stripPausedTag = (): void => {
    try {
      const note = orch.deps.notes.getById(taskId);
      if (!note) return;
      if (!note.tags?.includes(AUTO_CODE_PAUSED_TAG)) return;
      orch.deps.notes.update(
        taskId,
        {
          tags: (note.tags ?? []).filter(
            (t) => t !== AUTO_CODE_PAUSED_TAG,
          ),
        },
        AUTO_CODE_ACTOR,
      );
    } catch (err) {
      console.error(
        '[workflow-orchestrator] strip auto-code-paused failed:',
        err,
      );
    }
  };

  return {
    onRunStart: (run) => {
      // Re-drag = fresh attempt. Drop the auto-code-paused tag a
      // prior failed run left on the ticket so the visual state +
      // Mo's read of "is this ticket paused?" both reset.
      stripPausedTag();
      moveKanban('doing');
      // Trunk-guard snapshot: capture working-tree hashes of every
      // tracked file in the linked repo BEFORE any agent code runs.
      // The audit hook in onRunTerminal reverts any new dirty file
      // the agent leaks into trunk (legacy claude-launcher spawns
      // with cwd=repoPath; if `--worktree` is silently ignored or
      // a Bash tool escapes the worktree, writes can land in
      // trunk's checkout). User-already-dirty files are preserved
      // because the snapshot records THEIR baseline hash, not
      // HEAD's, so the audit only flags files that became dirty
      // during the run. Captured async fire-and-forget so the run
      // doesn't block on the git ops; if the snapshot fails the
      // audit later skips silently.
      void (async () => {
        try {
          const r = await snapshotTrunkState(run.repoPath);
          if (r.ok) {
            orch.trunkSnapshots.set(run.id, r.snapshot);
          } else {
            console.warn(
              `[trunk-guard] snapshot failed for run ${run.id}: ${r.message}`,
            );
          }
        } catch (err) {
          console.warn(
            `[trunk-guard] snapshot threw for run ${run.id}:`,
            err,
          );
        }
      })();
      // Footprint comment. Shape depends on whether this is a v2
      // DAG workflow (mo_stage decisions drive routing — listing
      // stages as a "chain" is misleading because the actual path
      // is decided at runtime) or a legacy linear workflow (chain
      // is meaningful).
      const isDag = run.graphSnapshot.stages.some(
        (s) =>
          s.kind === 'mo_stage' ||
          s.kind === 'mo_router' ||
          s.kind === 'reject_sink' ||
          s.kind === 'complete_sink',
      );
      if (isDag) {
        // Just announce the start — Mo's per-stage decision
        // comments will tell the user what's happening as the
        // workflow advances. Avoid enumerating all stages
        // because the DAG includes BOTH the accept and reject
        // branches; printing both as if they were sequential is
        // confusing ("Pipeline: ... → reject_terminal →
        // complete_terminal" wrongly implies the ticket will
        // hit reject before complete).
        post(
          `Auto-code picked this up. Started a fresh worktree (\`.morion/worktrees/${worktreeName}\`). Mo will post a decision comment at each gate as the workflow advances.`,
        );
      } else {
        const chain = describeAgentChain(run.graphSnapshot);
        const hasReviewStage = run.graphSnapshot.stages.length > 1;
        const reviewLine = hasReviewStage
          ? ' The final stage decides approve / reopen / escalate.'
          : '';
        post(
          `Auto-code picked this up. Started a fresh worktree (\`.morion/worktrees/${worktreeName}\`). Pipeline: ${chain}.${reviewLine}`,
        );
      }
    },
    onStageStart: ({ run, stage, attempt }) => {
      // Reopen-loop re-entry: a reviewer asked for another fix
      // attempt, so the fix stage spawns a 2nd/3rd time. Move
      // the card back to `doing` from wherever the prior review
      // boundary left it (typically `review`). For attempt=1 the
      // run-start hook already moved it; nothing to do.
      const reopenTarget = findReopenTargetStageId(run.graphSnapshot);
      if (stage.id === reopenTarget && attempt > 1) {
        moveKanban('doing');
        post(
          `Reviewer requested reopen — running ${stage.id} attempt ${attempt}.`,
        );
      }
    },
    onStageEnd: async ({ run, stage, stageRow }) => {
      // Phase 4 — surface mo_stage / sink comments to the ticket.
      // The runner stores the rendered comment text on
      // `stageRow.output.comment`. Sinks (reject_sink / complete_sink)
      // also have it; their post is handled here so the user sees
      // the workflow-authored message before onRunTerminal posts the
      // generic completion line.
      if (stageRow.status === 'done' && stageRow.output) {
        const out = stageRow.output as Record<string, unknown>;
        const comment = typeof out.comment === 'string' ? out.comment : '';
        if (
          comment &&
          (stageRow.stageKind === 'mo_stage' ||
            stageRow.stageKind === 'mo_router' ||
            stageRow.stageKind === 'reject_sink' ||
            stageRow.stageKind === 'complete_sink' ||
            stageRow.stageKind === 'eject')
        ) {
          post(comment);
        }
      }
      // 2026-05-13 — surface cli_agent / mcp_tool_call summaries
      // as ticket comments too. Previously the agent's final
      // output (review summary, fix summary, mcp tool result)
      // lived only in `workflow_run_stages.output_json`. Mo's
      // downstream decisions saw it via `stageOutputs` in the
      // prompt, but the user's ticket thread didn't, AND the
      // next Mo decision's `reason` field is short generic
      // prose — Mo couldn't quote the reviewer back verbatim.
      //
      // Posting the summary as a comment fixes both:
      //   - User sees the agent's actual reasoning on the ticket.
      //   - Mo's `recentComments` context on the NEXT stage's
      //     decision call includes the full text, so reopen
      //     reasons can quote the reviewer and the next fix
      //     attempt's prompt (which pulls recentComments) gets
      //     the concrete list of issues.
      //
      // Length cap: agent summaries can be huge (Pi often emits
      // multi-kb prose). Trim to 4000 chars with a clear suffix
      // so the comment thread stays readable. The full text
      // remains in `output_json` for the drawer transcript.
      if (
        stageRow.status === 'done' &&
        stageRow.output &&
        (stageRow.stageKind === 'cli_agent' ||
          stageRow.stageKind === 'mcp_tool_call')
      ) {
        const out = stageRow.output as Record<string, unknown>;
        const summary =
          typeof out.summary === 'string'
            ? out.summary
            : typeof out.data === 'string'
              ? out.data
              : null;
        if (summary && summary.trim().length > 0) {
          // Phase 6 V2 (Morion ticket 01KRG02E2SV2F9F3PZ6TPDDCNA)
          // — Mo composes a SHORT 1-2 sentence comment instead of
          // dumping the agent's verbatim multi-kb output into the
          // activity feed. The verbatim text still lives on
          // stage_row.output.summary for the drawer transcript.
          //
          // Fallback when Mo isn't wired / errored: post a
          // sparse heading + truncated verbatim so the user still
          // sees something. Same shape as the pre-V2 path but
          // capped tighter (1200 chars vs 4000) since the
          // activity feed is for skimming.
          let composed: string | null = null;
          if (orch.deps.moMessenger) {
            try {
              const r = await orch.deps.moMessenger.summarizeStage({
                ticketTitle: run.graphSnapshot.name,
                ticketBody:
                  orch.deps.notes.getById(run.ticketId)?.body ?? '',
                stageId: stage.id,
                agentName: stageRow.agentName,
                agentSummary: summary,
                terminalStatus: stageRow.status,
                folderId: run.folderId,
              });
              if (r.ok) composed = r.comment;
              else {
                // Mo failed; log + fall through to verbatim.
                console.warn(
                  `[workflow-orchestrator] Mo summarize failed for stage ${stage.id}: ${r.error}: ${r.message}`,
                );
              }
            } catch (err) {
              console.warn(
                `[workflow-orchestrator] Mo summarize threw for stage ${stage.id}:`,
                err,
              );
            }
          }
          if (composed) {
            // Mo's curated comment — short, ticket-feed-friendly.
            // Lead with the stage label so the activity feed reads
            // as a clean timeline.
            const label =
              stageRow.stageKind === 'cli_agent' && stageRow.agentName
                ? `**${stage.id}** · ${stageRow.agentName}${stageRow.attempt > 1 ? ` (attempt ${stageRow.attempt})` : ''}`
                : `**${stage.id}**${stageRow.attempt > 1 ? ` (attempt ${stageRow.attempt})` : ''}`;
            post(`${label} — ${composed}`);
          } else {
            // Fallback verbatim path — tighter cap than V1
            // (1200 vs 4000) because skimming is the use case.
            const FALLBACK_CAP = 1200;
            const trimmed =
              summary.length > FALLBACK_CAP
                ? `${summary.slice(0, FALLBACK_CAP)}\n\n…(truncated; full text in the Auto-code drawer)`
                : summary;
            const header =
              stageRow.stageKind === 'cli_agent' && stageRow.agentName
                ? `📝 **${stage.id}** · ${stageRow.agentName}${stageRow.attempt > 1 ? ` (attempt ${stageRow.attempt})` : ''}`
                : `📝 **${stage.id}**${stageRow.attempt > 1 ? ` (attempt ${stageRow.attempt})` : ''}`;
            post(`${header}\n\n${trimmed}`);
          }
        }
      }
      // Fix → review boundary: move the card to `review` so the
      // user sees the second-opinion stage is now active. Mirrors
      // the legacy orchestrator's transition on `fix_review` →
      // `review_running`. Applies on EVERY successful fix attempt
      // (initial + reopens) — each fix.done leads back into review.
      //
      // Single-stage templates (e.g. `claude-solo`) skip this move
      // entirely — there is no review stage, the next event is
      // onRunTerminal which moves the card straight to `done`.
      // Without this guard the card would briefly land in `review`
      // and flicker to `done` immediately after.
      //
      // For DAG workflows the array-order "next stage" lookup is
      // meaningless (edges drive routing); skip the kanban-move
      // heuristic on those — the workflow author owns the model
      // already, no implicit "fix→review" move.
      if (stageRow.status !== 'done') return;
      if (run.graphSnapshot.stages.some((s) => s.kind === 'mo_stage' || s.kind === 'reject_sink' || s.kind === 'complete_sink')) {
        return;
      }
      const stages = run.graphSnapshot.stages;
      const idx = stages.findIndex((s) => s.id === stageRow.stageIdInGraph);
      if (idx < 0 || idx >= stages.length - 1) return;
      const nextStage = stages[idx + 1];
      // Move to `review` whenever a non-terminal stage finishes —
      // the kanban column is symbolic ("the next stage is running")
      // not literally tied to a stage named `review`. For workflows
      // where the next stage is itself another fix-style stage,
      // this is still the right move: agent-output-pending-review
      // beats blocking on a more granular column scheme.
      moveKanban('review');
      const nextDescriptor = stageDescriptor(nextStage);
      if (stageRow.attempt === 1) {
        post(
          `${capitalise(stageDescriptor(stages[idx]))} produced a result. Starting ${nextDescriptor}.`,
        );
      } else {
        post(
          `${capitalise(stageDescriptor(stages[idx]))} attempt ${stageRow.attempt} produced a new result (after reviewer requested reopen). Re-running ${nextDescriptor}.`,
        );
      }
    },
    onRunTerminal: async (run) => {
      // Trunk-guard audit FIRST — runs regardless of terminal
      // state (done / failed / cancelled). Any file the agent
      // dirtied in trunk (vs the pre-run snapshot) is reverted via
      // `git checkout HEAD -- <path>`. Posts a Mo footprint when
      // a leak is detected so the user sees the cleanup happened.
      const snap = orch.trunkSnapshots.get(run.id);
      orch.trunkSnapshots.delete(run.id);
      if (snap) {
        try {
          const audit = await auditTrunkAfterRun(snap);
          if (audit.ok && audit.leakedFiles.length > 0) {
            const revert = await revertLeakedFiles(
              run.repoPath,
              audit.leakedFiles,
            );
            const revertedList = revert.reverted
              .map((p) => `\`${p}\``)
              .join(', ');
            const failedList = revert.failed
              .map((f) => `\`${f.path}\` (${f.message})`)
              .join('; ');
            const headWarn = audit.headChanged
              ? '\n\nNote: HEAD moved during the run — audit may have missed leaks beyond the baseline ref.'
              : '';
            const failedNote = revert.failed.length
              ? `\n\nFailed to revert: ${failedList}.`
              : '';
            post(
              `⚠️ Trunk guard: auto-code wrote ${audit.leakedFiles.length} file${audit.leakedFiles.length === 1 ? '' : 's'} to your trunk checkout (instead of the worktree). Auto-reverted: ${revertedList}.${failedNote}${headWarn}\n\nThis is a known bug class — the agent's \`--worktree\` flag or cwd was bypassed somewhere mid-run. Your trunk is back to HEAD; the run's own diff stays on the worktree branch and can still be merged normally.`,
            );
          } else if (!audit.ok) {
            console.warn(
              `[trunk-guard] audit failed for run ${run.id}: ${audit.message}`,
            );
          }
        } catch (err) {
          console.warn(
            `[trunk-guard] audit threw for run ${run.id}:`,
            err,
          );
        }
      }

      if (run.status === 'done') {
        moveKanban('done');
        // "Reviewer approved" only makes sense when the run actually
        // went through a verdict-policy stage. Single-stage templates
        // (claude-solo) just complete; phrasing claiming reviewer
        // approval would be a lie.
        const lastStage = run.graphSnapshot.stages.at(-1);
        const reviewerApproved =
          lastStage?.kind === 'cli_agent' && !!lastStage.verdictPolicy;
        const cost = `$${run.totalCostUsd.toFixed(4)}`;
        // Action-oriented done comment so the user reading the
        // activity feed sees WHAT to do next, not just "complete".
        // The drawer's "Merge into main" button lands the worktree
        // branch on trunk; until they click it (or the auto-merge
        // folder setting fires) the changes are isolated on the
        // auto-code branch — visible via `.morion/worktrees/<name>`
        // but NOT on the user's trunk checkout. Spell that out so a
        // non-tech user doesn't assume "done" means "merged".
        const approvalLine = reviewerApproved
          ? 'Mo reviewed and approved the changes.'
          : 'Mo finished the work.';
        post(
          `✓ Auto-code done. ${approvalLine}\n\nThe changes live on a separate branch (\`.morion/worktrees/${worktreeName}\`) — your trunk isn't touched yet. Click **Merge into main** in the Auto-code drawer to land them, or **Show files** to preview the diff.\n\nCost: ${cost}.`,
        );
        // Auto-merge hook: when wired AND the per-folder toggle
        // is on, this fires the merge + posts a "✓ Merged into
        // main" comment in one go, so the user never has to
        // click the drawer button. When off / unset, the callback
        // is a no-op (or the field is absent) and the manual
        // merge button stays the only path. Errors are advisory —
        // the run is already `done` and the user can retry merge
        // manually from the drawer.
        if (orch.deps.autoMergeAfterDone) {
          try {
            await orch.deps.autoMergeAfterDone(run);
          } catch (err) {
            console.error(
              '[workflow-orchestrator] auto-merge hook failed:',
              err,
            );
          }
        }
      } else if (run.status === 'failed') {
        moveKanban('backlog');
        const reason = run.lastError ?? '(no reason given)';
        // Phase 4 — workflow-deliberate rejection (reject_sink)
        // skips the `auto-code-paused` tag and the generic
        // "Auto-code paused" comment. The sink's rendered
        // commentTemplate was already posted by onStageEnd.
        if (reason.startsWith(REJECTED_BY_WORKFLOW_PREFIX)) {
          return;
        }
        tagPaused();
        // Reviewer-driven escalation gets a real Ask Mo chat
        // session (sidebar badge + needsHuman=true) so the user
        // sees an actionable triage thread, not just a passive
        // ticket comment. Mirrors the legacy
        // `openEscalationChat(folderId, taskId, reason, raw)`
        // pattern. Other failure modes (`budget_exhausted`,
        // `reopen_cap_exhausted`, `verdict_misconfigured`,
        // adapter `errorKind`) stay comment-only because they
        // aren't questions the user can answer in chat — they're
        // pre-existing bugs/configs the user fixes in code/UI.
        const escalatedPrefix = 'escalated_by_review:';
        if (reason.startsWith(escalatedPrefix)) {
          const reviewerReason = reason.slice(escalatedPrefix.length).trim();
          const sessionId = await openEscalationChat(orch, 
            run.folderId,
            run.ticketId,
            reviewerReason,
          );
          const sessionLine = sessionId
            ? `\n\nOpened Ask Mo chat session for triage.`
            : '';
          post(
            `Auto-code paused — reviewer escalated. ${reviewerReason}${sessionLine}\n\nTagged \`auto-code-paused\`. Re-drag to \`todo\` to retry, or address the feedback first.`,
          );
        } else {
          // Translate cryptic sentinels ("interrupted_by_restart",
          // "mo_provider_unconfigured", "worktree_setup_failed: …")
          // into actionable copy + keep the raw string in a fenced
          // block at the end. User feedback 2026-05-19 — the bare
          // sentinel left users with nothing to do.
          post(formatFailureComment(humanizeFailureReason(run.lastError)));
        }
      } else if (run.status === 'cancelled') {
        // No kanban move — the cancel almost always came from the
        // user's own kanban move or toggle-off, so the card is
        // already where they want it. A second move would race
        // with the user's intent.
        const reason = run.lastError ?? '(unknown reason)';
        post(`Auto-code cancelled: ${reason}.`);
        // Worktree cleanup (ticket 01KRFX0PNE4WAFTDYJ3FQPK8F7).
        // Cancelled runs are abandoned by definition — no merge
        // path, no need to inspect agent output. Drop the worktree
        // immediately so disk + git ref-list stay clean. Best-
        // effort — the next ticket-retrigger uses a fresh
        // `auto-<ulid>` name so a stuck removal doesn't block
        // future runs.
        orch.cleanupWorktreeFn({
          repoPath: run.repoPath,
          worktreeName,
          worktreePath: run.worktreePath,
        }).catch(() => {});
      }
      // `failed` keeps the worktree on purpose — the user often
      // wants to inspect what the agent produced (or didn't) and
      // possibly merge a partial diff manually. The Drawer's
      // explicit "Delete worktree" button drops it once they're
      // done inspecting. App-startup orphan sweep is the safety
      // net for failed worktrees that get forgotten.
    },
  };
}

import type { WorkflowRunsRepository } from './runs-repository.js';

/**
 * Cross-run memory — "Mo = router, not narrator" epic.
 *
 * A re-enqueued ticket used to start amnesiac: the new run saw only
 * the ticket body + recent comments, while the previous run's reject
 * reason, reviewer verdicts, and diffstats sat unread (and
 * un-truncated) in `workflow_runs` / `workflow_run_stages`. Result:
 * the second run stepped on exactly the same rakes.
 *
 * This module builds a DETERMINISTIC (no LLM) digest of the ticket's
 * previous terminal runs for the `{{ticket.priorRuns}}` template key
 * and the mo_stage decision scope. Per user decision (2026-07-14):
 * last 3 runs, ~3k chars each — a summary with pointers; the FULL
 * detail stays readable on demand (agents have Read/Bash: transcript
 * JSONL paths are listed per stage, and the run ids key into
 * workflow_run_stages.output_json).
 *
 * Stages are listed newest-first inside each run so the per-run cap
 * truncates the oldest stages, never the final verdict.
 */

const MAX_RUNS = 3;
const PER_RUN_CAP = 3_000;
const SUMMARY_EXCERPT = 700;
const DIFFSTAT_EXCERPT = 400;

const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

function excerpt(text: string, cap: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap)}… [truncated — full text in the run's stage outputs]`;
}

export function buildPriorRunsBlock(
  repo: WorkflowRunsRepository,
  ticketId: string,
  opts: { excludeRunId?: string } = {},
): string {
  const runs = repo
    .listRunsForTicket(ticketId, MAX_RUNS * 4)
    .filter(
      (r) => r.id !== opts.excludeRunId && TERMINAL_STATUSES.has(r.status),
    )
    .slice(0, MAX_RUNS);
  if (runs.length === 0) return '';

  const blocks: string[] = [
    `## Previous auto-code runs of this ticket (newest first)`,
    `The digests below are summaries. Full stage outputs live in run records (run ids listed); full agent conversations in the transcript files (readable with your file tools).`,
  ];

  for (const run of runs) {
    const lines: string[] = [];
    const finished = run.finishedAt
      ? new Date(run.finishedAt).toISOString()
      : 'unknown';
    const branch = run.worktreePath.split('/').pop() ?? run.worktreePath;
    lines.push(``);
    lines.push(`### Run ${run.id} — ${run.status} (finished ${finished})`);
    lines.push(`worktree branch: ${branch}`);
    if (run.lastError) {
      lines.push(`outcome: ${excerpt(run.lastError, SUMMARY_EXCERPT)}`);
    }

    // Newest-first so the cap eats the run's OLDEST stages.
    const stages = repo.listStagesForRun(run.id).reverse();
    for (const stage of stages) {
      const output = (stage.output ?? null) as Record<string, unknown> | null;
      if (!output) continue;
      if (stage.stageKind === 'mo_stage' || stage.stageKind === 'mo_router') {
        const branchPick =
          typeof output.branch === 'string' ? output.branch : '?';
        const reason =
          typeof output.reason === 'string' ? output.reason : '';
        lines.push(
          `- mo decision \`${stage.stageIdInGraph}\`: ${branchPick} — ${excerpt(reason, SUMMARY_EXCERPT)}`,
        );
      } else if (stage.stageKind === 'cli_agent') {
        const summary =
          typeof output.summary === 'string' ? output.summary : '';
        if (summary) {
          lines.push(
            `- agent \`${stage.stageIdInGraph}\` (${stage.agentName ?? '?'}, ${stage.status}): ${excerpt(summary, SUMMARY_EXCERPT)}`,
          );
        }
        const diffstat =
          typeof output.diffstat === 'string' ? output.diffstat : '';
        if (diffstat) {
          lines.push(`  files changed:\n${excerpt(diffstat, DIFFSTAT_EXCERPT)}`);
        }
        if (stage.transcriptPath) {
          lines.push(`  transcript: ${stage.transcriptPath}`);
        }
      }
    }

    let block = lines.join('\n');
    if (block.length > PER_RUN_CAP) {
      block = `${block.slice(0, PER_RUN_CAP)}\n… [run digest truncated — read the transcripts / stage outputs above for the rest]`;
    }
    blocks.push(block);
  }

  return blocks.join('\n');
}

import type { ToolContext } from '../../tools/types.js';
import type { AgentQueueRepository } from '../../../core/auto-code/queue.js';
import type { WorkflowRunsRepository } from '../../../core/auto-code/workflows/runs-repository.js';
import { inFlightSummary } from '../../../core/auto-code/toggle-killer.js';
import type { InflightOverview } from './types.js';

/** Build the in-flight overview closure. Always touches BOTH tables
 *  regardless of the workspace engine flag — switching the flag
 *  mid-flight must not hide rows from the previously-active engine.
 *  De-dups task titles in case the same task appears in both. */
export function buildInflightOverview(deps: {
  toolCtx: ToolContext;
  agentQueue: AgentQueueRepository;
  runsRepo: WorkflowRunsRepository;
}): (folderId: string) => InflightOverview {
  const { toolCtx, agentQueue, runsRepo } = deps;
  return (folderId) => {
    const legacy = inFlightSummary(agentQueue, folderId, (taskId) =>
      toolCtx.notes.getById(taskId),
    );
    const workflow = runsRepo.listActiveRunsInFolder(folderId);
    const workflowTitles: string[] = [];
    for (const run of workflow) {
      const t = toolCtx.notes.getById(run.ticketId);
      if (t?.title) workflowTitles.push(t.title);
    }
    // De-dup task titles in case the same task appears in BOTH tables
    // (rare during engine flips, but possible).
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const title of [...legacy.taskTitles, ...workflowTitles]) {
      if (!seen.has(title)) {
        seen.add(title);
        merged.push(title);
      }
    }
    return {
      count: legacy.count + workflow.length,
      taskTitles: merged,
    };
  };
}

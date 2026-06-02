import type { ToolContext } from '../../tools/types.js';
import { AgentQueueRepository } from '../../../core/auto-code/queue.js';
import { ConciergeFolderSettingsRepository } from '../../../core/concierge/folder-settings-repository.js';
import { WorkflowRunsRepository } from '../../../core/auto-code/workflows/runs-repository.js';
import { collapseWorkflowResult } from './helpers.js';
import { buildWorkflowOrchestrator } from './workflow-orchestrator.js';
import {
  buildCancelTicket,
  buildCancelFolder,
} from './dispatcher-cancel.js';
import { buildInflightOverview } from './dispatcher-inflight.js';
import type { AutoCodeDispatcher } from './types.js';

// Re-export the public surface so existing call sites
// (`from './auto-code-factory.js'`) keep working unchanged.
export {
  readAutoCodeMonthlyCap,
  detectClaudeAuthSource,
} from './settings.js';
export type {
  AutoCodeDispatcher,
  InflightOverview,
  UnifiedCancelSummary,
  UnifiedEnqueueResult,
} from './types.js';
export { buildWorkflowOrchestrator } from './workflow-orchestrator.js';
export {
  inspectFolderWorkflowResolution,
  type FolderWorkflowResolutionDiagnostic,
} from './folder-workflow-resolver.js';

// ---------------------------------------------------------------------
// Unified dispatcher — workflow runner is the only engine
// (ticket 01KRB0W7CV1PF48YD8FF6J14DG retired the legacy orchestrator).
// Cancel + inflight still touch the legacy `mo_agent_queue` table so
// rows that pre-date retirement keep getting drained / counted until
// the table empties.
// ---------------------------------------------------------------------

export async function buildAutoCodeDispatcher(
  toolCtx: ToolContext,
): Promise<AutoCodeDispatcher> {
  const agentQueue = new AgentQueueRepository(toolCtx.db);
  const runsRepo = new WorkflowRunsRepository(toolCtx.db);
  // Construct a folder-settings repo directly from the db so the
  // cancel paths work even when `toolCtx.concierge` isn't wired
  // (legacy queue rows still need cancelling regardless of Mo state).
  const folderSettingsRepo = new ConciergeFolderSettingsRepository(toolCtx.db);

  const workflowOrch = await buildWorkflowOrchestrator(toolCtx);

  const cancelTicket = buildCancelTicket({
    agentQueue,
    folderSettingsRepo,
    runsRepo,
    workflowOrch,
  });
  const cancelFolder = buildCancelFolder({
    agentQueue,
    folderSettingsRepo,
    runsRepo,
    workflowOrch,
  });
  const inflightOverview = buildInflightOverview({
    toolCtx,
    agentQueue,
    runsRepo,
  });

  // Read paths (cancel + inflight) work even without an active engine —
  // legacy queue rows + workflow_runs rows can outlive the engine that
  // created them. The enqueue path is the only one that needs an active
  // engine; without one we soft-reject with `auto_code_unavailable`
  // so callers can surface a clear error.
  if (workflowOrch) {
    return {
      isWorkflowRunner: true,
      async enqueueTicket(noteId, folderId) {
        return collapseWorkflowResult(
          await workflowOrch.enqueueTicket(noteId, folderId),
        );
      },
      cancelTicket,
      cancelFolder,
      inflightOverview,
      // Phase 5 — chat route hook calls this when a user message
      // lands in a workflow-linked Ask Mo session.
      resumeFromHumanGate: async (input) => {
        await workflowOrch.resumeFromHumanGate(input);
      },
    };
  }

  // No workflow engine wired (Mo not configured, no agent CLI detected).
  // Cancel + inflight still work; enqueue soft-rejects.
  return {
    isWorkflowRunner: true,
    enqueueTicket: async () => ({
      kind: 'rejected',
      reason: 'auto_code_unavailable',
      missingDetails: [
        'No auto-code engine is wired in this process. Verify Mo is configured + the claude CLI is installed.',
      ],
    }),
    cancelTicket,
    cancelFolder,
    inflightOverview,
  };
}

import type { AgentQueueRepository } from '../../../core/auto-code/queue.js';
import type { ConciergeFolderSettingsRepository } from '../../../core/concierge/folder-settings-repository.js';
import type { WorkflowRunsRepository } from '../../../core/auto-code/workflows/runs-repository.js';
import type { WorkflowOrchestrator } from '../../../core/auto-code/workflows/workflow-orchestrator.js';
import {
  cancelInFlightForFolder,
  cancelInFlightForTask,
  type CancelSummary,
} from '../../../core/auto-code/toggle-killer.js';
import type { UnifiedCancelSummary } from './types.js';

/** Closures that fan a cancel out across BOTH engines. Read-only deps
 *  (no orchestrator required) — these still work after Mo is disabled
 *  so user-initiated stop-all flows can clean up legacy queue rows. */
export interface DispatcherCancelDeps {
  agentQueue: AgentQueueRepository;
  folderSettingsRepo: ConciergeFolderSettingsRepository;
  runsRepo: WorkflowRunsRepository;
  workflowOrch: WorkflowOrchestrator | null;
}

export function buildCancelTicket(
  deps: DispatcherCancelDeps,
): (folderId: string, ticketId: string, reason?: string) => Promise<UnifiedCancelSummary> {
  const { agentQueue, folderSettingsRepo, workflowOrch } = deps;
  return async (folderId, ticketId, reason = 'parent_handle_cancel') => {
    const folderSettings = folderSettingsRepo.getOrDefault(folderId);
    const repoPath = folderSettings?.linkedRepoPath ?? '';
    let legacy: CancelSummary | null = null;
    if (repoPath) {
      try {
        legacy = await cancelInFlightForTask(folderId, ticketId, {
          queue: agentQueue,
          repoPath,
          reason,
        });
      } catch (err) {
        console.error('[auto-code] legacy cancelInFlightForTask threw:', err);
      }
    }
    const workflowRunIds: string[] = [];
    if (workflowOrch) {
      try {
        const r = await workflowOrch.cancelTicket(folderId, ticketId, reason);
        if (r.cancelledRunId) workflowRunIds.push(r.cancelledRunId);
      } catch (err) {
        console.error('[auto-code] workflow cancelTicket threw:', err);
      }
    }
    return { legacy, workflowRunIds };
  };
}

export function buildCancelFolder(
  deps: DispatcherCancelDeps,
): (folderId: string, reason?: string) => Promise<UnifiedCancelSummary> {
  const { agentQueue, folderSettingsRepo, runsRepo, workflowOrch } = deps;
  return async (folderId, reason = 'toggle_off') => {
    const folderSettings = folderSettingsRepo.getOrDefault(folderId);
    const repoPath = folderSettings?.linkedRepoPath ?? '';
    let legacy: CancelSummary | null = null;
    if (repoPath) {
      try {
        legacy = await cancelInFlightForFolder(folderId, {
          queue: agentQueue,
          repoPath,
        });
      } catch (err) {
        console.error('[auto-code] legacy cancelInFlightForFolder threw:', err);
      }
    }
    const workflowRunIds: string[] = [];
    if (workflowOrch) {
      const active = runsRepo.listActiveRunsInFolder(folderId);
      for (const run of active) {
        try {
          await workflowOrch.cancelTicket(run.folderId, run.ticketId, reason);
          workflowRunIds.push(run.id);
        } catch (err) {
          console.error('[auto-code] workflow folder-cancel row failed:', err);
        }
      }
    }
    return { legacy, workflowRunIds };
  };
}

import { fetchOrThrow } from '../http';
import type {
  AutoCodeBudgetStatus,
  AutoCodeInflightSummary,
  AutoCodeQueueRow,
} from '../types';

/**
 * Auto-Code run listing + monthly budget. The /runs/batch lookup
 * powers the kanban-card badge surface; chunk-mode below 200 ids is
 * URL-parser-friendly and the server hard-caps at 500 anyway.
 */
export const autocodeRunsApi = {
  getAutoCodeInflight: async (folderId: string): Promise<AutoCodeInflightSummary> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/auto-code/inflight`,
    );
    return (await res.json()) as AutoCodeInflightSummary;
  },
  /** All auto-code queue rows for a single task — newest first. Powers
   *  the AutoCodeDrawer's run picker so the user can flip between the
   *  current attempt + previous escalated/done attempts. */
  getAutoCodeRuns: async (taskId: string): Promise<{ rows: AutoCodeQueueRow[] }> => {
    const res = await fetchOrThrow(
      `/api/auto-code/runs?taskId=${encodeURIComponent(taskId)}`,
    );
    return (await res.json()) as { rows: AutoCodeQueueRow[] };
  },
  /** Workspace-wide auto-code monthly budget snapshot — current spend,
   *  cap, withinBudget gate, reset timestamp, auth source label. */
  getAutoCodeBudget: async (): Promise<AutoCodeBudgetStatus> => {
    const res = await fetchOrThrow('/api/auto-code/budget');
    return (await res.json()) as AutoCodeBudgetStatus;
  },
  /** Update the monthly cap. Workspace-wide setting. Returns the
   *  fresh status after the write so the UI re-paints with the new
   *  withinBudget value. */
  putAutoCodeBudget: async (
    monthlyCapUsd: number,
  ): Promise<AutoCodeBudgetStatus> => {
    const res = await fetchOrThrow('/api/auto-code/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyCapUsd }),
    });
    return (await res.json()) as AutoCodeBudgetStatus;
  },
  /** Batch latest-row-per-task lookup — one network hit, one SQL query.
   *  Powers the kanban-card badge surface. Tasks with no auto-code
   *  activity are simply absent from `rowsByTask` to save wire bytes
   *  on auto-code-disabled folders. Returns empty `{}` when called
   *  with zero ids (no fetch). */
  getAutoCodeRunsBatch: async (
    taskIds: readonly string[],
  ): Promise<{ rowsByTask: Record<string, AutoCodeQueueRow | null> }> => {
    if (taskIds.length === 0) return { rowsByTask: {} };
    // Cap path length to be friendly to URL parsers + reverse proxies;
    // chunk above 200 ids. Server hard-caps at 500 too.
    const chunkSize = 200;
    const merged: Record<string, AutoCodeQueueRow | null> = {};
    for (let i = 0; i < taskIds.length; i += chunkSize) {
      const chunk = taskIds.slice(i, i + chunkSize);
      const res = await fetchOrThrow(
        `/api/auto-code/runs/batch?taskIds=${encodeURIComponent(chunk.join(','))}`,
      );
      const { rowsByTask } = (await res.json()) as {
        rowsByTask: Record<string, AutoCodeQueueRow | null>;
      };
      Object.assign(merged, rowsByTask);
    }
    return { rowsByTask: merged };
  },
};

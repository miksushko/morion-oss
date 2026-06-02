/**
 * SQLite row shape + `rowToAgent` mapper for `mo_agent_queue`. Extracted from
 * `../queue.ts` (2026-05-16, ticket `01KRQYRP1KPN25W5F4PTC7E9XJ`). Internal
 * to the queue module — exported only because `repository.ts` consumes it.
 */

import type { AgentQueueRow, AgentQueueState } from './types.js';

export interface Row {
  id: string;
  folder_id: string;
  task_id: string;
  state: string;
  attempts: number;
  reopen_count: number;
  repo_path: string;
  worktree_name: string | null;
  fix_session_id: string | null;
  review_session_id: string | null;
  last_verdict: string | null;
  last_error: string | null;
  active_pid: number | null;
  session_group_id: string | null;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
}

export function rowToAgent(row: Row): AgentQueueRow {
  return {
    id: row.id,
    folderId: row.folder_id,
    taskId: row.task_id,
    state: row.state as AgentQueueState,
    attempts: row.attempts,
    reopenCount: row.reopen_count,
    repoPath: row.repo_path,
    worktreeName: row.worktree_name,
    fixSessionId: row.fix_session_id,
    reviewSessionId: row.review_session_id,
    lastVerdict: row.last_verdict,
    lastError: row.last_error,
    activePid: row.active_pid,
    sessionGroupId: row.session_group_id,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

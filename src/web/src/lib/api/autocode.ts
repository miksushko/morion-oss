/**
 * Auto-Code workflow runner endpoints — composed barrel over four
 * sub-modules under ./autocode/:
 *
 *   - runs        run listing, in-flight, budget, batch lookup
 *   - merge       merge stack: merge, conflict-prepare, apply, AI
 *                 resolve, abort, status, diff-stat, file content,
 *                 worktree cleanup
 *   - transcript  paused-session deep link, sessions listing,
 *                 one-shot transcript, SSE stream URL
 *   - workflows   shipped templates, per-folder custom workflow CRUD,
 *                 preflight
 *
 * Several methods do RAW fetch instead of `fetchOrThrow` because every
 * non-2xx envelope is part of the normal UX story (merge_conflict,
 * working_tree_dirty, target_branch_missing, etc.) and we want the
 * structured `{ok:false, error, message}` body, not the
 * `POST /api/... failed: 4xx:` plumbing string. See ./autocode/merge.ts.
 */

import { autocodeMergeApi } from './autocode/merge';
import { autocodeRunsApi } from './autocode/runs';
import { autocodeTranscriptApi } from './autocode/transcript';
import { autocodeWorkflowsApi } from './autocode/workflows';

export const autocodeApi = {
  ...autocodeRunsApi,
  ...autocodeMergeApi,
  ...autocodeTranscriptApi,
  ...autocodeWorkflowsApi,
};

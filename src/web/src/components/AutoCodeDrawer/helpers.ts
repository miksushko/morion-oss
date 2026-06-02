import type { AutoCodeQueueRow, AutoCodeQueueState } from '../../lib/api';
import type { DrawerSessionEntry } from './types';

export const STATE_BADGES: Record<AutoCodeQueueState, { label: string; className: string }> = {
  pending: { label: 'pending', className: 'bg-muted text-muted-foreground' },
  fix_running: { label: 'fix running', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  fix_review: { label: 'capturing diff', className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  review_running: {
    label: 'review running',
    className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  },
  reopened: { label: 'reopened', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  done: { label: 'done', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  done_merged: {
    label: 'done & merged',
    className: 'bg-emerald-600/20 text-emerald-700 dark:text-emerald-300 border border-emerald-600/40',
  },
  failed: { label: 'escalated', className: 'bg-destructive/15 text-destructive' },
  cancelled: { label: 'cancelled', className: 'bg-muted text-muted-foreground' },
  paused_ask_user: {
    label: 'awaiting your reply',
    className: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  },
};

/** Filesystem path the "Show files" / "Open in editor" buttons should
 *  reveal. For pre-merge `done` runs we point at the worktree (where
 *  the agent's changes live before merge); for `done_merged` runs we
 *  point at the linked repo root (the worktree is usually reaped by
 *  the orchestrator's terminal hook, and the changes are now in the
 *  user's main checkout). For everything else the path is just the
 *  repo root so the user can peek at the work-in-progress branch in
 *  git if they want — but the buttons are hidden in those states. */
export function effectivePathForRow(row: AutoCodeQueueRow): string | null {
  if (row.state === 'done_merged') return row.repoPath;
  if (row.state === 'done' && row.worktreeName) {
    // Worktrees moved from `.claude/worktrees/` → `.morion/worktrees/`
    // (2026-05-11); new runs all live under `.morion/`. Falls back to
    // repoPath via the IPC's path-exists check on legacy runs.
    return `${row.repoPath}/.morion/worktrees/${row.worktreeName}`;
  }
  return null;
}

/** Short symbol prefix shown inside <option> labels for the session
 *  selector. <option> can't host React elements, so we encode status
 *  as a single glyph in front of the label. */
export function renderSessionStatusDot(status: string): string {
  switch (status) {
    case 'running':
      return '◐';
    case 'done':
      return '●';
    case 'failed':
      return '⨯';
    case 'cancelled':
      return '○';
    case 'pending':
      return '⊙';
    default:
      return '•';
  }
}

/** Translates a `DrawerSessionEntry` into the api-client `session`
 *  argument: legacy literal for `mo_agent_queue` rows, structured
 *  `{stageId, stageRowId}` for workflow rows. */
export function sessionSelectorToApiArg(
  s: DrawerSessionEntry,
): 'fix' | 'review' | { stageId: string; stageRowId?: string } {
  if (s.engine === 'legacy') {
    return s.stageId === 'review' ? 'review' : 'fix';
  }
  return { stageId: s.stageId, ...(s.rowId ? { stageRowId: s.rowId } : {}) };
}

/** Stable dependency key for the transcript hook — combines engine +
 *  rowId/stageId so React effects don't re-fire on object-identity
 *  churn that doesn't change the URL we'd hit. */
export function sessionDepKey(s: DrawerSessionEntry): string {
  return s.engine === 'workflow' && s.rowId ? `wf:${s.rowId}` : `legacy:${s.stageId}`;
}

/** Stable key for the session-selector <option> values. We can't just
 *  use `stageId` — a reopen-loop produces multiple attempts of the
 *  same graph stage with different stage rows. */
export function sessionEntryKey(s: DrawerSessionEntry): string {
  return s.engine === 'workflow' && s.rowId ? s.rowId : `legacy:${s.stageId}`;
}

/** Truncate long transcript message bodies so a 50KB tool result
 *  doesn't blow up the drawer paint. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[${s.length - max} more chars]`;
}

/** Absolute filesystem path the "Resume in terminal" footer should
 *  `cd` into before invoking `claude --resume`. Worktree if one was
 *  provisioned (the post-rename `.morion/worktrees/` path), repo root
 *  otherwise. */
export function resumeCwdForRow(row: AutoCodeQueueRow): string {
  return row.worktreeName
    ? `${row.repoPath}/.morion/worktrees/${row.worktreeName}`
    : row.repoPath;
}

/** Absolute filesystem path for the worktree's copy of a changed
 *  file. Used by the "Open in editor" CTA inside `FileDiffModal`. */
export function worktreeFilePath(
  repoPath: string,
  worktreeName: string | null,
  path: string,
): string {
  return worktreeName
    ? `${repoPath}/.morion/worktrees/${worktreeName}/${path}`
    : `${repoPath}/${path}`;
}

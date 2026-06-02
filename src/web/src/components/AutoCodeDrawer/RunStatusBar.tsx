import { useEffect, useState } from 'react';
import { Code2, FolderOpen } from 'lucide-react';
import {
  api,
  type AutoCodeMergeStatusResult,
  type AutoCodeQueueRow,
} from '../../lib/api';
import { isTauri } from '../../lib/env';
import { openInEditor, revealInFinder } from '../../lib/revealPath';
import { cn } from '../../lib/cn';
import { ConflictResolverModal } from '../ConflictResolverModal';
import { STATE_BADGES, effectivePathForRow } from './helpers';
import { MergeConfirmModal } from './MergeConfirmModal';
import { RunMoreMenu } from './RunMoreMenu';

export function RunStatusBar({ row }: { row: AutoCodeQueueRow }) {
  const badge = STATE_BADGES[row.state];
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [pathActionError, setPathActionError] = useState<string | null>(null);
  const path = effectivePathForRow(row);
  const showPathActions = path !== null && isTauri;
  const hasTerminalUI =
    (row.state === 'done' && row.worktreeName) ||
    row.state === 'done_merged' ||
    showPathActions;

  // Probe trunk for stale mid-merge state (Codex 2026-05-12). When
  // a prior merge attempt left MERGE_HEAD set (browser closed mid-
  // resolution, sidecar restarted, commit-hook failed, etc.) we want
  // to show "Resume conflict / Abort" instead of the regular Merge
  // button — clicking Merge against a mid-merge trunk just re-fails.
  // Probe only when row could plausibly be merge-able to avoid an
  // extra request per drawer open.
  const [mergeStatus, setMergeStatus] = useState<AutoCodeMergeStatusResult | null>(null);
  useEffect(() => {
    if (row.state !== 'done') {
      setMergeStatus(null);
      return;
    }
    let cancelled = false;
    api
      .getAutoCodeMergeStatus(row.id)
      .then((r) => {
        if (!cancelled) setMergeStatus(r);
      })
      .catch(() => {
        // Network / 404 — fall back to no-status which renders the
        // regular Merge button (safer baseline).
        if (!cancelled) setMergeStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [row.id, row.state]);

  const midMergeOurs =
    mergeStatus?.ok === true && mergeStatus.inProgress && mergeStatus.isOurMerge;
  const midMergeForeign =
    mergeStatus?.ok === true && mergeStatus.inProgress && !mergeStatus.isOurMerge;

  const onAbortFromBar = async () => {
    setPathActionError(null);
    try {
      await api.abortAutoCodeMerge(row.id);
      const fresh = await api.getAutoCodeMergeStatus(row.id);
      setMergeStatus(fresh);
    } catch (err) {
      setPathActionError(
        `Abort failed: ${(err as Error).message ?? String(err)}`,
      );
    }
  };

  const onReveal = async () => {
    if (!path) return;
    setPathActionError(null);
    try {
      await revealInFinder(path);
    } catch (err) {
      setPathActionError(
        `Could not open in Finder: ${(err as Error).message ?? String(err)}`,
      );
    }
  };
  const onOpenEditor = async () => {
    if (!path) return;
    setPathActionError(null);
    try {
      await openInEditor(path);
    } catch (err) {
      setPathActionError(
        `Could not open in editor: ${(err as Error).message ?? String(err)}`,
      );
    }
  };

  return (
    <div className="border-b">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs">
        <span
          className={cn('rounded-full px-2 py-0.5 font-medium uppercase tracking-wide', badge.className)}
        >
          {badge.label}
        </span>
        <span className="text-muted-foreground">attempts: {row.attempts}</span>
        <span className="text-muted-foreground">reopens: {row.reopenCount}</span>
        {row.lastVerdict && (
          <span className="text-muted-foreground">last: {row.lastVerdict}</span>
        )}
        {row.state === 'done' && row.worktreeName && !midMergeOurs && !midMergeForeign && (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="ml-auto rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
            title={`Merge worktree branch ${row.worktreeName} into main`}
          >
            Merge into main
          </button>
        )}
        {row.state === 'done' && midMergeOurs && (
          <div className="ml-auto flex items-center gap-1">
            <span
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
              title={`Trunk has MERGE_HEAD=${mergeStatus?.ok && mergeStatus.inProgress ? mergeStatus.mergeHeadRef.slice(0, 8) : '?'} from a prior attempt. ${mergeStatus?.ok && mergeStatus.inProgress ? mergeStatus.unresolvedCount : 0} files unresolved.`}
            >
              mid-merge
            </span>
            <button
              type="button"
              onClick={() => setResumeOpen(true)}
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
              title="Resume the existing conflict resolution session"
            >
              Resume conflict
            </button>
            <button
              type="button"
              onClick={() => void onAbortFromBar()}
              className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/20"
              title="Discard all conflict resolutions and return trunk to HEAD"
            >
              Abort merge
            </button>
          </div>
        )}
        {row.state === 'done' && midMergeForeign && (
          <div className="ml-auto flex items-center gap-1">
            <span
              className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive"
              title={`Trunk is mid-merging a DIFFERENT branch (MERGE_HEAD=${mergeStatus?.ok && mergeStatus.inProgress ? mergeStatus.mergeHeadRef.slice(0, 8) : '?'}). Cancel that merge first.`}
            >
              foreign merge in progress
            </span>
            <button
              type="button"
              onClick={() => void onAbortFromBar()}
              className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/20"
              title="Abort the foreign merge so this run can be merged afresh"
            >
              Abort foreign merge
            </button>
          </div>
        )}
        {row.state === 'done_merged' && (
          <span
            className="ml-auto rounded-md border border-emerald-600/40 bg-emerald-600/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
            title="This worktree branch was merged into main via the drawer button."
          >
            ✓ Merged into main
          </span>
        )}
        {showPathActions && (
          <div
            className={cn(
              'flex items-center gap-1',
              !(
                (row.state === 'done' && row.worktreeName) ||
                row.state === 'done_merged'
              ) && 'ml-auto',
            )}
          >
            <button
              type="button"
              onClick={() => void onReveal()}
              className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground hover:bg-muted"
              title={
                row.state === 'done_merged'
                  ? `Reveal ${row.repoPath} in Finder`
                  : `Reveal ${path} in Finder`
              }
            >
              <FolderOpen className="h-3 w-3" />
              Show files
            </button>
            <button
              type="button"
              onClick={() => void onOpenEditor()}
              className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground hover:bg-muted"
              title={`Open ${path} in VS Code (falls back to default editor)`}
            >
              <Code2 className="h-3 w-3" />
              Open in editor
            </button>
          </div>
        )}
        <RunMoreMenu row={row} pinRightWhenNoPathActions={!showPathActions} />
        <span
          className={cn(
            'truncate text-muted-foreground',
            !hasTerminalUI && 'ml-auto',
          )}
          title={row.repoPath}
        >
          {row.worktreeName ?? '(no worktree yet)'}
        </span>
      </div>
      {pathActionError && (
        <div className="border-t border-destructive/30 bg-destructive/10 px-4 py-1 text-[11px] text-destructive">
          {pathActionError}
        </div>
      )}
      {confirmOpen && (
        <MergeConfirmModal
          row={row}
          onClose={() => setConfirmOpen(false)}
        />
      )}
      {resumeOpen && (
        <ConflictResolverModal
          runId={row.id}
          onComplete={() => {
            setResumeOpen(false);
            void api
              .getAutoCodeMergeStatus(row.id)
              .then(setMergeStatus)
              .catch(() => setMergeStatus(null));
          }}
          onClose={() => {
            setResumeOpen(false);
            void api
              .getAutoCodeMergeStatus(row.id)
              .then(setMergeStatus)
              .catch(() => setMergeStatus(null));
          }}
        />
      )}
    </div>
  );
}

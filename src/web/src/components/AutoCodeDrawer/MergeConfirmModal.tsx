import { useState } from 'react';
import { api, type AutoCodeQueueRow } from '../../lib/api';
import { ConflictResolverModal } from '../ConflictResolverModal';
import type { MergeOutcome } from './types';

/** Confirmation + result modal for the "Merge into main" action.
 *  Default target = `main` (server falls back to master if main is
 *  absent — we surface that in the success message). Strategy
 *  defaults to `no-ff` so the auto-code branch stays visible in
 *  `git log --graph`. */
export function MergeConfirmModal({
  row,
  onClose,
}: {
  row: AutoCodeQueueRow;
  onClose: () => void;
}) {
  // Empty default → backend auto-detects main / master and reports
  // which one it picked back in the success envelope. Hardcoding
  // "main" caused 404s on repos with `master` (the legacy default
  // git initialised before ~2020). Let the user override only when
  // they care about a non-trunk target.
  const [targetBranch, setTargetBranch] = useState('');
  const [strategy, setStrategy] = useState<'no-ff' | 'ff-only' | 'auto'>('no-ff');
  const [outcome, setOutcome] = useState<MergeOutcome>({ kind: 'idle' });

  // The workflow runner creates the worktree branch with the same
  // name as the worktree directory (`auto-XXX`). Legacy claude-launcher
  // used `worktree-auto-XXX` — the backend probes both at merge time.
  // Display the actual branch name verbatim instead of a hardcoded
  // prefix that's wrong for ~every current run.
  const branchName = row.worktreeName ?? '<no worktree>';

  const onConfirm = async () => {
    setOutcome({ kind: 'merging' });
    try {
      const result = await api.mergeAutoCodeRun(row.id, {
        targetBranch: targetBranch.trim() || undefined,
        strategy,
      });
      if ('ok' in result && result.ok) {
        const autoCommitNote = result.autoCommitted
          ? ` (auto-committed ${result.autoCommitted.filesChanged} file${result.autoCommitted.filesChanged === 1 ? '' : 's'} as ${result.autoCommitted.sha} first)`
          : '';
        setOutcome({
          kind: 'ok',
          message: `Merged \`${result.mergedBranch}\` → \`${result.targetBranch}\`${autoCommitNote}`,
          stat: result.stat,
        });
      } else {
        setOutcome({
          kind: 'err',
          message: result.message || 'Merge failed without a message.',
          errorCode: result.error,
        });
      }
    } catch (err) {
      setOutcome({
        kind: 'err',
        message: (err as Error).message ?? 'Network error.',
      });
    }
  };

  const [resolverOpen, setResolverOpen] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && outcome.kind !== 'merging') onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-background p-4 shadow-xl">
        <h3 className="mb-2 text-sm font-semibold">Merge worktree into main</h3>
        <p className="mb-3 text-[12px] text-muted-foreground">
          This runs <code className="font-mono">git merge {branchName}</code>{' '}
          on the linked repo's trunk checkout. Working tree must be clean.
        </p>
        <div className="mb-3 space-y-2">
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            Target branch (empty = auto-detect main / master)
            <input
              value={targetBranch}
              onChange={(e) => setTargetBranch(e.target.value)}
              disabled={outcome.kind === 'merging' || outcome.kind === 'ok'}
              placeholder="(leave empty to use main, or master if main is absent)"
              className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[12px] text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            Strategy
            <select
              value={strategy}
              onChange={(e) =>
                setStrategy(e.target.value as 'no-ff' | 'ff-only' | 'auto')
              }
              disabled={outcome.kind === 'merging' || outcome.kind === 'ok'}
              className="rounded-md border border-border bg-background px-2 py-1 text-[12px] text-foreground"
            >
              <option value="no-ff">--no-ff (default — preserve branch in history)</option>
              <option value="ff-only">--ff-only (refuse on divergence)</option>
              <option value="auto">auto (let git decide)</option>
            </select>
          </label>
        </div>
        {outcome.kind === 'err' && (
          <>
            <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-[11px] text-destructive whitespace-pre-wrap break-words">
              {outcome.message}
            </div>
            {outcome.errorCode === 'merge_conflict' && (
              <div className="mb-3 flex flex-col items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                <div>
                  Mo can open a 3-pane editor (HEAD ↔ incoming ↔ merged) so
                  you can resolve each conflict region without dropping to
                  a terminal.
                </div>
                <button
                  type="button"
                  onClick={() => setResolverOpen(true)}
                  className="rounded-md bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-700"
                >
                  Resolve conflict
                </button>
              </div>
            )}
          </>
        )}
        {outcome.kind === 'ok' && (
          <div className="mb-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-[11px] text-emerald-700 dark:text-emerald-300">
            <div>{outcome.message}</div>
            {outcome.stat && (
              <div className="mt-1 font-mono text-[10px] text-emerald-700/80 dark:text-emerald-400/80">
                {outcome.stat}
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={outcome.kind === 'merging'}
            className="rounded-md border border-border px-3 py-1 text-[12px] hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {outcome.kind === 'ok' ? 'Close' : 'Cancel'}
          </button>
          {outcome.kind !== 'ok' && (
            <button
              type="button"
              onClick={() => void onConfirm()}
              disabled={outcome.kind === 'merging'}
              className="rounded-md bg-emerald-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {outcome.kind === 'merging' ? 'Merging…' : 'Merge'}
            </button>
          )}
        </div>
      </div>
      {resolverOpen && (
        <ConflictResolverModal
          runId={row.id}
          targetBranchOverride={targetBranch.trim() || undefined}
          strategy={strategy}
          onComplete={(r) => {
            setResolverOpen(false);
            setOutcome({
              kind: 'ok',
              message:
                r.resolved.length > 0
                  ? `Merged with manual conflict resolution (${r.resolved.length} file${r.resolved.length === 1 ? '' : 's'}). Commit: ${r.sha}`
                  : `Merged cleanly on retry.`,
              stat: r.stat,
            });
          }}
          onClose={() => {
            setResolverOpen(false);
            // Backend already ran `git merge --abort`. Surface a
            // hint so the user knows to re-click Merge to retry.
            setOutcome({
              kind: 'err',
              message:
                'Conflict resolution cancelled. The merge was aborted; your trunk is clean. Click Merge again to retry, or fix the underlying conflict cause (re-run the ticket against the new base, etc.).',
              errorCode: 'cancelled',
            });
          }}
        />
      )}
    </div>
  );
}

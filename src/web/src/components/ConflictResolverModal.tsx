import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';

import { ConflictPane } from './conflict-resolver/ConflictPane';
import { FileSidebar } from './conflict-resolver/FileSidebar';
import { ResolverFooter } from './conflict-resolver/ResolverFooter';
import { useConflictResolver } from './conflict-resolver/useConflictResolver';

/**
 * Conflict-resolver modal — full-screen 3-pane Monaco editor that
 * opens from MergeConfirmModal's error state when the user clicks
 * "Resolve conflict".
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ Title bar: file count + cancel                             │
 *   ├──────────────┬─────────────────────────────────────────────┤
 *   │ File sidebar │  Conflict region nav (prev/next + count)    │
 *   │              ├─────────────────────────────────────────────┤
 *   │ • game.js    │  Accept current / incoming / both           │
 *   │ • style.css  ├──────────┬──────────┬──────────────────────┤
 *   │              │  Ours    │  Theirs  │  Merged (editable)   │
 *   │              │  (HEAD)  │ (branch) │                      │
 *   │              ├──────────┴──────────┴──────────────────────┤
 *   │              │  Footer: leftover markers + Apply / Cancel │
 *   └──────────────┴─────────────────────────────────────────────┘
 *
 * # File layout (2026-05-16 refactor)
 *
 * Pure presentation shell. All state + admission flow lives in
 * `useConflictResolver`. Sibling modules under `./conflict-resolver/`:
 *
 *   - `useConflictResolver.ts` state machine + prepare call + Retry/
 *                              Abort branching + AI auto-resolve flow
 *   - `parse.ts`               CONFLICT_RE / LEFTOVER_MARKER_RE +
 *                              parseConflictRegions / applyAccept /
 *                              countLeftoverMarkers / countLeftoverFiles
 *   - `language.ts`            EXT_TO_LANG + inferLanguage (Monaco syntax)
 *   - `FileSidebar.tsx`        left rail file list + per-file marker badge
 *   - `ConflictPane.tsx`       region nav + accept buttons + 3 editors
 *   - `SidePane.tsx`           read-only Ours / Theirs side pane
 *   - `ResolverFooter.tsx`     banners (AI summary, recoverable error
 *                              with Retry/Abort) + status line + action
 *                              buttons (Try AI, Cancel & abort, Apply)
 *
 * Pure helpers in `parse.ts` + `language.ts` are pinned by
 * `tests/conflict-resolver-parse.test.ts` (16 cases) and
 * `tests/conflict-resolver-language.test.ts` (6 cases). The modal
 * itself stays covered by `tests/merge-conflict-resolver.test.ts`
 * (18 integration cases).
 */

interface Props {
  runId: string;
  /** Default target branch override the parent passed to the
   *  initial merge attempt. Forwarded to merge-conflict-prepare so
   *  the prepare merges into the same target. */
  targetBranchOverride?: string;
  /** Strategy override the parent used. */
  strategy?: 'no-ff' | 'ff-only' | 'auto';
  /** Called when the resolver completes successfully — parent
   *  should refresh the run row + close. */
  onComplete: (result: {
    sha: string;
    resolved: string[];
    stat: string | null;
  }) => void;
  /** Called when the user cancels (or modal close button). The
   *  backend will have called `git merge --abort` before this
   *  fires. */
  onClose: () => void;
}

export function ConflictResolverModal({
  runId,
  targetBranchOverride,
  strategy,
  onComplete,
  onClose,
}: Props) {
  const {
    status,
    error,
    conflict,
    selectedFile,
    drafts,
    aiBanner,
    applyFailureKind,
    retryCount,
    setSelectedFile,
    updateDraft,
    onApply,
    onCancel,
    onAiResolve,
  } = useConflictResolver({
    runId,
    targetBranchOverride,
    strategy,
    onComplete,
    onClose,
  });

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
      <div className="flex h-[92vh] w-full max-w-[1400px] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Merge conflict resolver
            </div>
            <div className="mt-0.5 truncate text-sm font-medium">
              {conflict
                ? `${conflict.files.length} file${conflict.files.length === 1 ? '' : 's'} in conflict · merging \`${conflict.branchName}\` into ${conflict.targetBranch ?? 'main/master'}`
                : status === 'loading'
                ? 'Preparing conflict state…'
                : 'Conflict resolver'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onCancel()}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Cancel + abort merge"
            disabled={status === 'applying' || status === 'aborting'}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {status === 'loading' && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Re-running merge to capture conflict state…
          </div>
        )}

        {status === 'error' && (
          <div className="m-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[12px] text-destructive whitespace-pre-wrap break-words">
            {error}
          </div>
        )}

        {conflict && selectedFile && (
          <div className="flex min-h-0 flex-1">
            <FileSidebar
              files={conflict.files}
              selected={selectedFile}
              drafts={drafts}
              onSelect={setSelectedFile}
            />
            <ConflictPane
              key={selectedFile}
              file={conflict.files.find((f) => f.path === selectedFile)!}
              draft={drafts[selectedFile] ?? ''}
              onDraftChange={(next) => updateDraft(selectedFile, next)}
            />
          </div>
        )}

        {conflict && (conflict.recovered || (conflict.activeCommitHooks && conflict.activeCommitHooks.length > 0)) && (
          <div className="border-t bg-amber-500/5 px-4 py-2 text-[11px]">
            {conflict.recovered && (
              <div className="text-amber-700 dark:text-amber-300">
                Resumed an existing conflict session (MERGE_HEAD was
                already set in your repo). Pick up where you left off.
              </div>
            )}
            {conflict.activeCommitHooks && conflict.activeCommitHooks.length > 0 && (
              <div className="mt-0.5 text-amber-700 dark:text-amber-300">
                Heads up — your repo has an active{' '}
                {conflict.activeCommitHooks.map((h, i) => (
                  <span key={h}>
                    {i > 0 && ', '}
                    <code className="font-mono text-[10px]">{h}</code>
                  </span>
                ))}{' '}
                hook. If it rejects the merge commit, Apply will surface
                a "commit failed, merge still open" error with Retry /
                Abort buttons.
              </div>
            )}
          </div>
        )}

        {conflict && (
          <ResolverFooter
            conflict={conflict}
            drafts={drafts}
            status={status}
            aiBanner={aiBanner}
            error={error}
            applyFailureKind={applyFailureKind}
            retryCount={retryCount}
            onApply={onApply}
            onCancel={onCancel}
            onAiResolve={onAiResolve}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

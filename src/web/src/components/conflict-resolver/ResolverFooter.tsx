/**
 * Bottom action bar of the conflict-resolver modal. Contains:
 *   - the AI auto-resolve summary banner (cost + ok/failed counts +
 *     expandable failure list);
 *   - the apply-error banner with Retry/Abort branch for the
 *     `commit_failed_merge_still_open` recoverable state and a "hook
 *     keeps rejecting" hint after ≥3 retries;
 *   - the status messaging (binary-files warning / all-resolved tick /
 *     unresolved counts);
 *   - the three action buttons (Try AI auto-resolve / Cancel & abort /
 *     Apply & merge).
 *
 * Extracted from ConflictResolverModal.tsx on 2026-05-16. The modal
 * shell stays under 300 LOC by hoisting the footer's ~170-LOC JSX
 * here.
 */
import { Check, Loader2, Sparkles } from 'lucide-react';

import type { AutoCodeMergePrepareResult } from '../../lib/api';
import { countLeftoverFiles, countLeftoverMarkers } from './parse';

type ConflictState = Extract<
  AutoCodeMergePrepareResult,
  { ok: true; clean: false }
>['conflict'];

export interface AiBanner {
  okCount: number;
  failedCount: number;
  totalCostUsd: number;
  anyFallback: boolean;
  primaryModel: string;
  failures: Array<{ path: string; reason: string; message: string }>;
}

export type ResolverStatus =
  | 'loading'
  | 'ready'
  | 'applying'
  | 'aborting'
  | 'ai-resolving'
  | 'error';

export function ResolverFooter({
  conflict,
  drafts,
  status,
  aiBanner,
  error,
  applyFailureKind,
  retryCount,
  onApply,
  onCancel,
  onAiResolve,
}: {
  conflict: ConflictState;
  drafts: Record<string, string>;
  status: ResolverStatus;
  aiBanner: AiBanner | null;
  error: string | null;
  applyFailureKind: 'commit_failed_merge_still_open' | null;
  retryCount: number;
  onApply: () => void | Promise<void>;
  onCancel: () => void | Promise<void>;
  onAiResolve: () => void | Promise<void>;
}) {
  const busy =
    status === 'applying' || status === 'aborting' || status === 'ai-resolving';

  return (
    <div className="border-t bg-muted/30 px-4 py-2">
      {aiBanner && (
        <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
          <div className="font-medium">
            AI proposed resolutions for {aiBanner.okCount} file
            {aiBanner.okCount === 1 ? '' : 's'}
            {aiBanner.failedCount > 0
              ? ` · failed on ${aiBanner.failedCount}`
              : ''}
            {' · '}
            ${aiBanner.totalCostUsd.toFixed(4)} spent
            {aiBanner.anyFallback ? ' (fallback model fired)' : ''}.
          </div>
          <div className="mt-0.5 text-[10px] opacity-80">
            Review the merged pane(s) below — manual edit allowed —
            then click Apply &amp; merge.
          </div>
          {aiBanner.failures.length > 0 && (
            <details className="mt-1 text-[10px] opacity-90">
              <summary className="cursor-pointer">
                Failed files ({aiBanner.failures.length})
              </summary>
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                {aiBanner.failures.map((f) => (
                  <li key={f.path} className="font-mono">
                    <span className="font-medium">{f.path}</span> ·{' '}
                    {f.reason}: {f.message.slice(0, 200)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {error && (
        <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive whitespace-pre-wrap break-words">
          <div>{error}</div>
          {applyFailureKind === 'commit_failed_merge_still_open' && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void onApply()}
                disabled={busy}
                className="flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                title="Re-attempt git commit. Resolved content is still staged."
              >
                Retry commit{retryCount > 0 ? ` (attempt ${retryCount + 1})` : ''}
              </button>
              <button
                type="button"
                onClick={() => void onCancel()}
                disabled={busy}
                className="rounded-md border border-destructive/60 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
                title="Abort the merge. All your resolutions will be discarded; trunk returns to HEAD."
              >
                Abort merge (discard resolutions)
              </button>
              {retryCount >= 3 && (
                <span className="ml-1 text-[11px] font-medium text-destructive">
                  Hook keeps rejecting — fix it in your repo first
                  (likely in <code className="font-mono text-[10px]">.git/hooks/pre-commit</code>{' '}
                  or your pre-commit config), or Abort to discard
                  resolutions.
                </span>
              )}
            </div>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] text-muted-foreground">
          <StatusLine conflict={conflict} drafts={drafts} />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onAiResolve()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md border border-purple-500/40 bg-purple-500/10 px-3 py-1 text-[12px] font-medium text-purple-700 hover:bg-purple-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:text-purple-300"
            title="Send conflicts to a frontier model (deepseek-v4-pro / claude-sonnet-4 fallback) to propose resolutions"
          >
            {status === 'ai-resolving' ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" /> Mo is
                resolving…
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3" /> Try AI auto-resolve
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => void onCancel()}
            disabled={busy}
            className="rounded-md border border-border px-3 py-1 text-[12px] hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === 'aborting' ? 'Aborting…' : 'Cancel & abort'}
          </button>
          <button
            type="button"
            onClick={() => void onApply()}
            disabled={
              busy ||
              countLeftoverMarkers(drafts) > 0 ||
              conflict.files.some((f) => f.binary)
            }
            className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === 'applying' ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" /> Applying…
              </>
            ) : (
              <>
                <Check className="h-3 w-3" /> Apply &amp; merge
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusLine({
  conflict,
  drafts,
}: {
  conflict: ConflictState;
  drafts: Record<string, string>;
}) {
  const binaryCount = conflict.files.filter((f) => f.binary).length;
  const textRemaining = countLeftoverMarkers(drafts);
  if (binaryCount > 0) {
    return (
      <span className="text-amber-700 dark:text-amber-400">
        {binaryCount} binary file{binaryCount === 1 ? '' : 's'} can't
        be text-resolved. Run{' '}
        <code className="font-mono text-[10px]">
          git checkout --ours -- &lt;path&gt;
        </code>{' '}
        (or <code className="font-mono text-[10px]">--theirs</code>)
        in your repo first, then retry Apply.
      </span>
    );
  }
  if (textRemaining === 0) {
    return (
      <span className="text-emerald-600 dark:text-emerald-400">
        ✓ All conflict regions resolved.
      </span>
    );
  }
  return (
    <>
      {textRemaining} unresolved region(s) across{' '}
      {countLeftoverFiles(drafts)} file(s). Resolve every one
      before applying, or let AI take a shot.
    </>
  );
}

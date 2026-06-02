/**
 * useConflictResolver — the state machine + admission flow of the
 * conflict-resolver modal.
 *
 * Extracted from ConflictResolverModal.tsx on 2026-05-16 so the shell
 * stays under the 300-LOC cap. Returns a bag of state + handlers the
 * shell renders. Owns:
 *
 *   - The one-shot prepare call (`api.prepareAutoCodeMergeConflict`)
 *     keyed on `runId`. The clean-merge happy path resolves through
 *     `onComplete` immediately; the conflict path populates `conflict`
 *     + `drafts` + `selectedFile`.
 *   - The Retry/Abort branching for `commit_failed_merge_still_open`
 *     including the consecutive-retry counter that the footer surfaces
 *     after ≥3 failures.
 *   - The AI auto-resolve flow + banner state.
 *   - Cancel = `git merge --abort` + parent `onClose`.
 *
 * The `onComplete` callback is held via a ref so re-renders of the
 * parent don't retrigger the prepare effect (observed 2026-05-12:
 * 18+ concurrent POST /merge-conflict-prepare → racing git ops →
 * trunk left in a dirty/staged state).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type AutoCodeMergePrepareResult } from '../../lib/api';
import { LEFTOVER_MARKER_RE } from './parse';
import type { AiBanner, ResolverStatus } from './ResolverFooter';

type ConflictState = Extract<
  AutoCodeMergePrepareResult,
  { ok: true; clean: false }
>['conflict'];

export interface UseConflictResolverInput {
  runId: string;
  targetBranchOverride?: string;
  strategy?: 'no-ff' | 'ff-only' | 'auto';
  onComplete: (result: { sha: string; resolved: string[]; stat: string | null }) => void;
  onClose: () => void;
}

export interface UseConflictResolverState {
  status: ResolverStatus;
  error: string | null;
  conflict: ConflictState | null;
  selectedFile: string | null;
  drafts: Record<string, string>;
  aiBanner: AiBanner | null;
  applyFailureKind: 'commit_failed_merge_still_open' | null;
  retryCount: number;
  setSelectedFile: (path: string) => void;
  setDrafts: (next: Record<string, string>) => void;
  updateDraft: (path: string, next: string) => void;
  onApply: () => Promise<void>;
  onCancel: () => Promise<void>;
  onAiResolve: () => Promise<void>;
}

export function useConflictResolver(
  input: UseConflictResolverInput,
): UseConflictResolverState {
  const { runId, targetBranchOverride, strategy, onComplete, onClose } = input;

  const [status, setStatus] = useState<ResolverStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  // Per-file edits — cached so switching files in the sidebar
  // doesn't lose draft state.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Banner state for the AI auto-resolve flow. Null when no AI call
   *  has fired this session; otherwise the latest call's summary. */
  const [aiBanner, setAiBanner] = useState<AiBanner | null>(null);
  /** Set when the LAST apply attempt failed in a specific recoverable
   *  way. `commit_failed_merge_still_open` lets the user Retry the
   *  commit (e.g. after fixing a pre-commit hook) OR Abort the whole
   *  merge (losing resolutions). Cleared on any other apply attempt. */
  const [applyFailureKind, setApplyFailureKind] = useState<
    'commit_failed_merge_still_open' | null
  >(null);
  /** Count of consecutive Retry attempts that hit the same
   *  `commit_failed_merge_still_open` error. After ≥3 failures the
   *  UI surfaces an extra hint that the hook reliably rejects + the
   *  Abort path is the realistic exit. Reset on any non-retry apply
   *  OR when the resolver modal is closed/reopened. */
  const [retryCount, setRetryCount] = useState(0);

  // Stable refs for parent-supplied callbacks — without these, every
  // parent re-render passes a NEW inline arrow function for
  // onComplete/onClose, the useEffect deps array sees a different
  // identity each render, and prepare fires in an infinite loop.
  // Observed 2026-05-12: 18+ concurrent POST /merge-conflict-prepare
  // within milliseconds → racing git ops → trunk left in dirty/staged
  // state from one of the concurrent runs.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  // Run the prepare call ONCE per modal lifetime — keyed only on
  // `runId` (the merge target). Strategy + target branch override
  // are forwarded but don't re-trigger; the modal closes + reopens
  // if those need to change. Callback identity is excluded by
  // design — see ref hoist above.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await api.prepareAutoCodeMergeConflict(runId, {
          targetBranch: targetBranchOverride,
          strategy: strategy ?? 'no-ff',
        });
        if (cancelled) return;
        if (!r.ok) {
          setError(r.message);
          setStatus('error');
          return;
        }
        if (r.clean) {
          // The merge happened to be conflict-free (e.g. between
          // the time the parent saw conflict and we re-tried, the
          // base shifted). Treat as success.
          onCompleteRef.current({
            sha: '',
            resolved: [],
            stat: r.merge.stat,
          });
          return;
        }
        setConflict(r.conflict);
        // Pre-fill drafts with the working-tree merged content
        // (conflict markers + git's auto-merge of non-conflicting
        // chunks). User edits flow into `drafts`.
        //
        // Codex P1.2: SKIP binary files. The editor pane shows them
        // as "resolve in terminal" copy, but if we still populated
        // `drafts[binary.path]` and the user clicked Apply, the
        // backend would write that string as UTF-8 to the binary
        // file's path, corrupting/wiping the binary content. By
        // omitting binary paths from drafts, Apply only ships
        // text-conflict resolutions; the backend separately rejects
        // any binary paths that sneak in (defence-in-depth).
        const initial: Record<string, string> = {};
        const firstTextFile = r.conflict.files.find((f) => !f.binary);
        for (const f of r.conflict.files) {
          if (f.binary) continue;
          initial[f.path] = f.merged;
        }
        setDrafts(initial);
        // Prefer a non-binary file as the initial selection — the
        // binary file would only show the "resolve in terminal"
        // message, which isn't useful as a landing state.
        setSelectedFile(firstTextFile?.path ?? r.conflict.files[0]?.path ?? null);
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        setError((e as Error).message ?? String(e));
        setStatus('error');
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const onCancel = useCallback(async () => {
    setStatus('aborting');
    try {
      await api.abortAutoCodeMerge(runId);
    } catch (err) {
      console.error('abort failed', err);
    }
    onClose();
  }, [runId, onClose]);

  const onAiResolve = useCallback(async () => {
    setStatus('ai-resolving');
    setError(null);
    setAiBanner(null);
    try {
      const r = await api.aiAutoResolveMerge(runId);
      if (!r.ok) {
        setError(r.message);
        setStatus('ready');
        return;
      }
      // Populate drafts with successful resolutions; preserve user's
      // existing draft for files the AI failed on.
      setDrafts((prev) => {
        const next = { ...prev };
        for (const f of r.results) {
          if (f.ok) next[f.path] = f.content;
        }
        return next;
      });
      const failures = r.results
        .filter((f) => !f.ok)
        .map((f) => ({
          path: f.path,
          reason: 'reason' in f ? f.reason : 'unknown',
          message: 'message' in f ? f.message : 'unknown failure',
        }));
      setAiBanner({
        okCount: r.okCount,
        failedCount: r.failedCount,
        totalCostUsd: r.totalCostUsd,
        anyFallback: r.anyFallback,
        primaryModel: r.primaryModel,
        failures,
      });
      setStatus('ready');
    } catch (e) {
      setError((e as Error).message ?? String(e));
      setStatus('ready');
    }
  }, [runId]);

  const onApply = useCallback(async () => {
    // Pre-flight check: any draft has leftover markers? Refuse.
    const violators: string[] = [];
    for (const [path, content] of Object.entries(drafts)) {
      if (LEFTOVER_MARKER_RE.test(content)) violators.push(path);
    }
    if (violators.length > 0) {
      setError(
        `${violators.length} file(s) still have conflict markers. Resolve every region before applying: ${violators.join(', ')}.`,
      );
      return;
    }
    setStatus('applying');
    setError(null);
    const wasInRetryState = applyFailureKind === 'commit_failed_merge_still_open';
    // Don't clear applyFailureKind here — we only want to clear it
    // when we transition OUT of the commit-fail state (success OR a
    // different error). Holding the previous kind through the loading
    // phase keeps the Retry/Abort buttons visible during the spinner.
    try {
      const r = await api.applyAutoCodeMergeResolution(runId, {
        resolvedFiles: drafts,
      });
      if (r.ok) {
        setRetryCount(0);
        onComplete({ sha: r.sha, resolved: r.resolved, stat: r.stat });
        return;
      }
      if (r.error === 'commit_failed_merge_still_open') {
        // Special UX: merge state preserved + resolutions still on
        // disk. Offer Retry / Abort in the banner instead of a
        // generic error. Bump the consecutive-retry counter so the
        // UI can surface "this hook reliably rejects" after a few
        // failed attempts.
        setApplyFailureKind('commit_failed_merge_still_open');
        setRetryCount((n) => (wasInRetryState ? n + 1 : 1));
        setError(r.message);
      } else if (r.error === 'leftover_markers' && r.violatingPaths) {
        setApplyFailureKind(null);
        setRetryCount(0);
        setError(
          `Backend rejected: ${r.violatingPaths.join(', ')} still have markers.`,
        );
      } else {
        setApplyFailureKind(null);
        setRetryCount(0);
        setError(r.message);
      }
      setStatus('ready');
    } catch (e) {
      setApplyFailureKind(null);
      setRetryCount(0);
      setError((e as Error).message ?? String(e));
      setStatus('ready');
    }
  }, [runId, drafts, onComplete, applyFailureKind]);

  const updateDraft = useCallback((path: string, next: string) => {
    setDrafts((d) => ({ ...d, [path]: next }));
  }, []);

  return {
    status,
    error,
    conflict,
    selectedFile,
    drafts,
    aiBanner,
    applyFailureKind,
    retryCount,
    setSelectedFile,
    setDrafts,
    updateDraft,
    onApply,
    onCancel,
    onAiResolve,
  };
}

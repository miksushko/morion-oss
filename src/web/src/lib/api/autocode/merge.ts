import { getApiBaseSync, getApiToken } from '../../env';
import { fetchOrThrow } from '../http';
import type {
  AutoCodeDiffStatResult,
  AutoCodeFileContentResult,
  AutoCodeMergeAiResolveResult,
  AutoCodeMergeApplyResult,
  AutoCodeMergePrepareResult,
  AutoCodeMergeResult,
  AutoCodeMergeStatusResult,
  AutoCodeRunFilesResult,
} from '../types';

/**
 * Auto-Code merge stack — the heavy sub-domain: merge a run's worktree
 * into trunk, prepare-conflict for the resolver modal, apply manual
 * resolution, ask Mo to AI-resolve, status probe, abort, plus diff
 * accessors (diff-stat, run files, per-file content) and manual
 * worktree cleanup.
 *
 * Several methods do RAW fetch instead of `fetchOrThrow` because every
 * non-2xx envelope is part of the normal UX story (merge_conflict,
 * working_tree_dirty, target_branch_missing, etc.) and we want the
 * structured `{ok:false, error, message}` body, not the
 * `POST /api/... failed: 4xx:` plumbing string.
 */
export const autocodeMergeApi = {
  /** Merge a `done` workflow run's worktree branch into the repo's
   *  main checkout. Backend probes `main` → `master` for default
   *  target when `targetBranch` is omitted. Strategy `no-ff`
   *  (default) preserves the auto-code branch in history;
   *  `ff-only` refuses on divergence; `auto` lets git decide.
   *
   *  Does NOT use `fetchOrThrow` because every failure mode the
   *  backend can emit (target_branch_missing → 404, working_tree_dirty
   *  → 409, merge_conflict → 409, etc.) is part of the normal UX
   *  story: the modal renders the `message` field inline. Letting
   *  fetchOrThrow throw with the raw `POST /api/... failed: 404:`
   *  format leaks HTTP plumbing into a user-facing dialog. We parse
   *  both 2xx and 4xx as the structured envelope; only network /
   *  parse failures surface as a thrown error. */
  mergeAutoCodeRun: async (
    runId: string,
    opts: {
      targetBranch?: string;
      strategy?: 'no-ff' | 'ff-only' | 'auto';
    } = {},
  ): Promise<AutoCodeMergeResult> => {
    const token = getApiToken();
    const res = await fetch(
      getApiBaseSync() +
        `/api/auto-code/runs/${encodeURIComponent(runId)}/merge`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-Morion-Token': token } : {}),
        },
        body: JSON.stringify(opts),
      },
    );
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error(
        `Merge request returned ${res.status} ${res.statusText} with a non-JSON body. The sidecar may have crashed mid-merge.`,
      );
    }
    return parsed as AutoCodeMergeResult;
  },
  /** On-demand diff summary for a done auto-code run. Returns a
   *  parsed shape suitable for "What Mo did" UI — files / additions
   *  / deletions / raw shortstat. Errors surface as a `{ok:false}`
   *  envelope; HTTP layer always returns 200 except for 402 (Pro
   *  required) and 404 (run not found). */
  getAutoCodeDiffStat: async (
    runId: string,
  ): Promise<AutoCodeDiffStatResult> => {
    const res = await fetchOrThrow(
      `/api/auto-code/runs/${encodeURIComponent(runId)}/diff-stat`,
    );
    return (await res.json()) as AutoCodeDiffStatResult;
  },
  /** List files changed by an auto-code run (worktree branch vs
   *  trunk). Capped at 500 entries; UI shows a "+N more" footer
   *  when `truncated: true`. */
  getAutoCodeRunFiles: async (
    runId: string,
  ): Promise<AutoCodeRunFilesResult> => {
    const res = await fetchOrThrow(
      `/api/auto-code/runs/${encodeURIComponent(runId)}/files`,
    );
    return (await res.json()) as AutoCodeRunFilesResult;
  },
  /** Run the merge with conflict-state preservation (`abortOnConflict:
   *  false`). On clean merge, returns `clean: true` + the regular
   *  merge envelope. On conflict, returns `clean: false` + per-file
   *  ours/theirs/merged content for the ConflictResolverModal. */
  prepareAutoCodeMergeConflict: async (
    runId: string,
    opts: { targetBranch?: string; strategy?: 'no-ff' | 'ff-only' | 'auto' } = {},
  ): Promise<AutoCodeMergePrepareResult> => {
    const token = getApiToken();
    const res = await fetch(
      getApiBaseSync() +
        `/api/auto-code/runs/${encodeURIComponent(runId)}/merge-conflict-prepare`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-Morion-Token': token } : {}),
        },
        body: JSON.stringify(opts),
      },
    );
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error(
        `merge-conflict-prepare returned ${res.status} ${res.statusText} with a non-JSON body.`,
      );
    }
    return parsed as AutoCodeMergePrepareResult;
  },
  /** Write resolved file content + commit, completing the merge that
   *  was left in mid-state by `prepareAutoCodeMergeConflict`. */
  applyAutoCodeMergeResolution: async (
    runId: string,
    body: {
      resolvedFiles: Record<string, string>;
      commitMessage?: string;
    },
  ): Promise<AutoCodeMergeApplyResult> => {
    const token = getApiToken();
    const res = await fetch(
      getApiBaseSync() +
        `/api/auto-code/runs/${encodeURIComponent(runId)}/merge-apply-resolution`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-Morion-Token': token } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error(
        `merge-apply-resolution returned ${res.status} ${res.statusText} with a non-JSON body.`,
      );
    }
    return parsed as AutoCodeMergeApplyResult;
  },
  /** Ask Mo to AI-resolve all open conflicts (ConflictResolverModal's
   *  "Try AI auto-resolve" button). Returns proposed file content per
   *  conflict + cost + which model produced each. UI populates the
   *  editor drafts; user reviews + Apply as usual. */
  aiAutoResolveMerge: async (
    runId: string,
  ): Promise<AutoCodeMergeAiResolveResult> => {
    const token = getApiToken();
    const res = await fetch(
      getApiBaseSync() +
        `/api/auto-code/runs/${encodeURIComponent(runId)}/merge-ai-resolve`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-Morion-Token': token } : {}),
        },
      },
    );
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error(
        `merge-ai-resolve returned ${res.status} ${res.statusText} with a non-JSON body.`,
      );
    }
    return parsed as AutoCodeMergeAiResolveResult;
  },
  /** Ticket 01KRFX0PNE4WAFTDYJ3FQPK8F7 — manual worktree cleanup.
   *  Drops the per-run git worktree (best-effort `git worktree remove
   *  --force`). Backend refuses for ACTIVE runs (running / pending /
   *  paused_ask_user) but accepts done / failed / cancelled /
   *  done_merged. UI shows a confirm dialog before calling so the
   *  user can't drop unmerged work by accident. */
  removeAutoCodeRunWorktree: async (
    runId: string,
  ): Promise<
    | { ok: true; removed: boolean; path?: string; reason?: string }
    | { ok: false; error: string; message?: string }
  > => {
    const token = getApiToken();
    const res = await fetch(
      getApiBaseSync() +
        `/api/auto-code/runs/${encodeURIComponent(runId)}/remove-worktree`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-Morion-Token': token } : {}),
        },
      },
    );
    return (await res.json()) as
      | { ok: true; removed: boolean; path?: string; reason?: string }
      | { ok: false; error: string; message?: string };
  },
  /** Stop an in-flight auto-code run — fans a cancel across both engines
   *  (legacy queue + workflow_runs), SIGTERMing the live cli_agent so it
   *  stops spending. Powers the RunStatusBar "Stop" button. Idempotent. */
  cancelAutoCodeRun: async (
    runId: string,
  ): Promise<
    | { ok: true; summary?: unknown }
    | { ok: false; error: string; message?: string }
  > => {
    const token = getApiToken();
    const res = await fetch(
      getApiBaseSync() +
        `/api/auto-code/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-Morion-Token': token } : {}),
        },
      },
    );
    return (await res.json()) as
      | { ok: true; summary?: unknown }
      | { ok: false; error: string; message?: string };
  },
  /** Probe trunk for mid-merge state. Powers the drawer-level
   *  "Resume / Abort" guard so the user doesn't click a regular
   *  Merge button against a repo that already has MERGE_HEAD set. */
  getAutoCodeMergeStatus: async (
    runId: string,
  ): Promise<AutoCodeMergeStatusResult> => {
    const res = await fetchOrThrow(
      `/api/auto-code/runs/${encodeURIComponent(runId)}/merge-status`,
    );
    return (await res.json()) as AutoCodeMergeStatusResult;
  },
  /** Cancel a mid-state merge — `git merge --abort` on trunk.
   *  Idempotent — returns `aborted: false` when no merge is active. */
  abortAutoCodeMerge: async (
    runId: string,
  ): Promise<{ ok: true; aborted: boolean } | { ok: false; error: string; message: string }> => {
    const token = getApiToken();
    const res = await fetch(
      getApiBaseSync() +
        `/api/auto-code/runs/${encodeURIComponent(runId)}/merge-abort`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-Morion-Token': token } : {}),
        },
      },
    );
    return (await res.json()) as
      | { ok: true; aborted: boolean }
      | { ok: false; error: string; message: string };
  },
  /** Before/after content for one file in an auto-code run's diff.
   *  Both sides capped at 200 KB; larger surfaces as `tooLarge:true`
   *  with size info so the UI can show an "Open in editor" CTA. */
  getAutoCodeFileContent: async (
    runId: string,
    path: string,
  ): Promise<AutoCodeFileContentResult> => {
    const res = await fetchOrThrow(
      `/api/auto-code/runs/${encodeURIComponent(runId)}/files/content?path=${encodeURIComponent(path)}`,
    );
    return (await res.json()) as AutoCodeFileContentResult;
  },
};

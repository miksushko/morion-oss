import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { worktreeBranchName } from './worktree-paths.js';

const execFileAsync = promisify(execFile);

/**
 * File-level diff inspection for auto-code runs. Powers the
 * AutoCodeDrawer's "Files changed" picker — list view + per-file
 * before/after content preview — so a non-tech user can review what
 * Mo did without dropping to `git diff` in a terminal.
 *
 * Sister helpers to `merge.ts` + `run-summary.ts`. All read-only,
 * never touch git state.
 *
 * Caps:
 *   - File list capped at 500 entries (giant refactor would otherwise
 *     swamp the drawer + drag the SQLite query plan). When truncated
 *     the response carries `truncated: true` + actual `totalFiles`.
 *   - Single-file content capped at 200 KB per side (before/after).
 *     Larger files surface as `tooLarge: true` with `size` byte
 *     count — UI shows "Open in editor" CTA instead of inline body.
 *   - Binary detection: git `--numstat` emits `-\t-\t<path>` for
 *     binary changes. We surface those with `binary: true` and skip
 *     the content fetch.
 */

const FILE_CONTENT_BYTE_CAP = 200 * 1024;
const FILES_LIST_CAP = 500;

const DEFAULT_TARGET_CANDIDATES = ['main', 'master'] as const;

export type GitFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | 'X' | 'B';

export interface ChangedFileEntry {
  /** Path relative to repo root (no leading slash). */
  readonly path: string;
  /** Old path when status === 'R' (rename) or 'C' (copy). Otherwise null. */
  readonly oldPath: string | null;
  readonly status: GitFileStatus;
  /** Numbers from `git diff --numstat`. Null when binary. */
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

export type ListChangedFilesResult =
  | {
      readonly ok: true;
      readonly targetBranch: string;
      readonly branchName: string;
      readonly files: readonly ChangedFileEntry[];
      readonly truncated: boolean;
      readonly totalFiles: number;
    }
  | {
      readonly ok: false;
      readonly error:
        | 'repo_not_found'
        | 'branch_missing'
        | 'target_missing'
        | 'git_error';
      readonly message: string;
    };

export interface ListChangedFilesArgs {
  repoPath: string;
  worktreeName: string;
  targetBranch?: string;
}

export async function listChangedFiles(
  args: ListChangedFilesArgs,
): Promise<ListChangedFilesResult> {
  const candidates = [args.worktreeName, worktreeBranchName(args.worktreeName)];
  let branchName: string | null = null;
  for (const c of candidates) {
    const r = await branchExists(args.repoPath, c);
    if (!r.ok) return r;
    if (r.exists) {
      branchName = c;
      break;
    }
  }
  if (!branchName) {
    return {
      ok: false,
      error: 'branch_missing',
      message: `Neither "${candidates[0]}" nor "${candidates[1]}" exists in ${args.repoPath}.`,
    };
  }
  const target = await resolveTarget(args.repoPath, args.targetBranch);
  if (!target.ok) return target;

  // name-status: tells us A/M/D/R/C per file.
  // numstat: tells us additions/deletions (or `-\t-` for binary).
  // We merge by path. `git diff` outputs name-status as
  // "<X><score?>\t<old>\t<new>" for R/C and "<X>\t<path>" otherwise.
  let nameStatusRaw = '';
  let numstatRaw = '';
  try {
    const ns = await execFileAsync(
      'git',
      ['-C', args.repoPath, 'diff', '--name-status', `${target.targetBranch}...${branchName}`],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    nameStatusRaw = ns.stdout;
    const num = await execFileAsync(
      'git',
      ['-C', args.repoPath, 'diff', '--numstat', `${target.targetBranch}...${branchName}`],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    numstatRaw = num.stdout;
  } catch (err) {
    return {
      ok: false,
      error: 'git_error',
      message: `git diff failed: ${trimErr(err)}`,
    };
  }

  // Parse name-status — keyed by NEW path.
  type ParsedNS = {
    status: GitFileStatus;
    path: string;
    oldPath: string | null;
  };
  const nsByPath = new Map<string, ParsedNS>();
  for (const line of nameStatusRaw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const rawStatus = parts[0]!;
    // R100 / C75 etc. — strip score suffix.
    const status = (rawStatus[0] ?? 'M') as GitFileStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = parts[1] ?? '';
      const newPath = parts[2] ?? oldPath;
      nsByPath.set(newPath, { status, path: newPath, oldPath });
    } else {
      const path = parts[1] ?? '';
      nsByPath.set(path, { status, path, oldPath: null });
    }
  }

  // Parse numstat — keyed by NEW path.
  type ParsedNum = { additions: number | null; deletions: number | null; binary: boolean };
  const numByPath = new Map<string, ParsedNum>();
  for (const line of numstatRaw.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const adds = parts[0]!;
    const dels = parts[1]!;
    // For renames numstat emits "added\tdeleted\told => new" or
    // "added\tdeleted\t<new>" depending on git version. Use the
    // last segment as path candidate; fall back to last \t-segment.
    let path = parts.slice(2).join('\t').trim();
    const arrowIdx = path.indexOf(' => ');
    if (arrowIdx >= 0) path = path.slice(arrowIdx + 4);
    const binary = adds === '-' && dels === '-';
    numByPath.set(path, {
      additions: binary ? null : Number(adds),
      deletions: binary ? null : Number(dels),
      binary,
    });
  }

  // Merge.
  const totalFiles = nsByPath.size;
  const entries: ChangedFileEntry[] = [];
  let count = 0;
  for (const ns of nsByPath.values()) {
    if (count >= FILES_LIST_CAP) break;
    const num = numByPath.get(ns.path) ?? { additions: 0, deletions: 0, binary: false };
    entries.push({
      path: ns.path,
      oldPath: ns.oldPath,
      status: ns.status,
      additions: num.additions,
      deletions: num.deletions,
      binary: num.binary,
    });
    count++;
  }

  return {
    ok: true,
    targetBranch: target.targetBranch,
    branchName,
    files: entries,
    truncated: totalFiles > FILES_LIST_CAP,
    totalFiles,
  };
}

export type FileContentResult =
  | {
      readonly ok: true;
      readonly targetBranch: string;
      readonly branchName: string;
      readonly path: string;
      readonly oldPath: string | null;
      readonly status: GitFileStatus;
      readonly binary: boolean;
      /** `before` is the content on the target branch (null when
       *  status === 'A' — file is new) OR null when too large /
       *  binary. */
      readonly before: string | null;
      /** `after` is the content on the worktree branch (null when
       *  status === 'D' — file was deleted) OR null when too large /
       *  binary. */
      readonly after: string | null;
      readonly beforeSize: number | null;
      readonly afterSize: number | null;
      readonly beforeTooLarge: boolean;
      readonly afterTooLarge: boolean;
    }
  | {
      readonly ok: false;
      readonly error:
        | 'repo_not_found'
        | 'branch_missing'
        | 'target_missing'
        | 'path_not_in_diff'
        | 'git_error';
      readonly message: string;
    };

export interface FileContentArgs {
  repoPath: string;
  worktreeName: string;
  path: string;
  targetBranch?: string;
}

export async function readFileBeforeAfter(
  args: FileContentArgs,
): Promise<FileContentResult> {
  // Walk the diff once to find the exact entry — gives us the
  // canonical status (A/M/D/R/C), binary flag, and old path (for
  // renames the `before` content lives at oldPath, not path).
  const list = await listChangedFiles({
    repoPath: args.repoPath,
    worktreeName: args.worktreeName,
    targetBranch: args.targetBranch,
  });
  if (!list.ok) return list;

  const entry = list.files.find((f) => f.path === args.path);
  if (!entry) {
    return {
      ok: false,
      error: 'path_not_in_diff',
      message: `"${args.path}" is not in the diff between ${list.targetBranch} and ${list.branchName}.`,
    };
  }

  const beforePath = entry.oldPath ?? entry.path;
  const beforeRef = entry.status === 'A' ? null : `${list.targetBranch}:${beforePath}`;
  const afterRef = entry.status === 'D' ? null : `${list.branchName}:${entry.path}`;

  const [before, after] = await Promise.all([
    beforeRef && !entry.binary ? gitShow(args.repoPath, beforeRef) : Promise.resolve({ ok: true as const, content: null, size: null, tooLarge: false }),
    afterRef && !entry.binary ? gitShow(args.repoPath, afterRef) : Promise.resolve({ ok: true as const, content: null, size: null, tooLarge: false }),
  ]);

  if (!before.ok) return { ok: false, error: 'git_error', message: before.message };
  if (!after.ok) return { ok: false, error: 'git_error', message: after.message };

  return {
    ok: true,
    targetBranch: list.targetBranch,
    branchName: list.branchName,
    path: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    binary: entry.binary,
    before: before.content,
    after: after.content,
    beforeSize: before.size,
    afterSize: after.size,
    beforeTooLarge: before.tooLarge,
    afterTooLarge: after.tooLarge,
  };
}

async function gitShow(
  repoPath: string,
  ref: string,
): Promise<
  | { ok: true; content: string | null; size: number | null; tooLarge: boolean }
  | { ok: false; message: string }
> {
  // First check size via `git cat-file -s`. Small enough → read content.
  // Too large → return tooLarge:true without burning memory.
  let size = 0;
  try {
    const s = await execFileAsync('git', ['-C', repoPath, 'cat-file', '-s', ref], {
      timeout: 10_000,
    });
    size = Number(s.stdout.trim());
    if (!Number.isFinite(size)) size = 0;
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    // ref might not exist (e.g. file is added — beforeRef points at
    // target where the file doesn't yet exist). Treat as "no content".
    if (e.code === 128 || /Not a valid object name/i.test(e.stderr ?? '')) {
      return { ok: true, content: null, size: null, tooLarge: false };
    }
    return { ok: false, message: `git cat-file -s ${ref} failed: ${trimErr(err)}` };
  }
  if (size > FILE_CONTENT_BYTE_CAP) {
    return { ok: true, content: null, size, tooLarge: true };
  }
  try {
    const r = await execFileAsync('git', ['-C', repoPath, 'show', ref], {
      timeout: 30_000,
      maxBuffer: FILE_CONTENT_BYTE_CAP * 2,
    });
    return { ok: true, content: r.stdout, size, tooLarge: false };
  } catch (err) {
    return { ok: false, message: `git show ${ref} failed: ${trimErr(err)}` };
  }
}

async function resolveTarget(
  repoPath: string,
  override?: string,
): Promise<
  | { ok: true; targetBranch: string }
  | { ok: false; error: 'repo_not_found' | 'target_missing' | 'git_error'; message: string }
> {
  if (override) {
    const r = await branchExists(repoPath, override);
    if (!r.ok) return r;
    if (!r.exists) {
      return {
        ok: false,
        error: 'target_missing',
        message: `Target branch "${override}" not found.`,
      };
    }
    return { ok: true, targetBranch: override };
  }
  for (const c of DEFAULT_TARGET_CANDIDATES) {
    const r = await branchExists(repoPath, c);
    if (r.ok && r.exists) return { ok: true, targetBranch: c };
  }
  return {
    ok: false,
    error: 'target_missing',
    message: 'Neither "main" nor "master" found in repo.',
  };
}

async function branchExists(
  repoPath: string,
  branch: string,
): Promise<
  | { ok: true; exists: boolean }
  | { ok: false; error: 'repo_not_found' | 'git_error'; message: string }
> {
  try {
    await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', '--verify', '--quiet', branch],
      { timeout: 10_000 },
    );
    return { ok: true, exists: true };
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    const stderr = (e.stderr ?? '').trim();
    if (/not a git repository/i.test(stderr)) {
      return {
        ok: false,
        error: 'repo_not_found',
        message: `Repo "${repoPath}" is not a git repository.`,
      };
    }
    if (e.code === 1 && stderr.length === 0) {
      return { ok: true, exists: false };
    }
    return {
      ok: false,
      error: 'git_error',
      message: `git rev-parse failed: ${trimErr(err)}`,
    };
  }
}

function trimErr(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; message?: string };
    if (typeof e.stderr === 'string' && e.stderr.length > 0) return e.stderr.trim();
    if (typeof e.message === 'string') return e.message.trim();
  }
  return String(err);
}

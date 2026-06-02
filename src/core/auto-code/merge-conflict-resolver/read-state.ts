import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileAsync, trimErr } from './internal.js';
import {
  FILE_CONTENT_BYTE_CAP,
  type ConflictFileEntry,
  type MergeConflictStateResult,
} from './types.js';

/** Read the trunk's mid-merge state. Returns inProgress=false when
 *  there's no MERGE_HEAD (no merge currently underway). */
export async function readMergeConflictState(
  repoPath: string,
): Promise<MergeConflictStateResult> {
  if (!existsSync(repoPath)) {
    return {
      ok: false,
      error: 'repo_not_found',
      message: `Repo path "${repoPath}" does not exist.`,
    };
  }
  // Is a merge in progress? `.git/MERGE_HEAD` is the canonical
  // signal; `git rev-parse --verify MERGE_HEAD` exits 0 when it
  // exists, non-zero when it doesn't.
  let mergeHeadRef = '';
  try {
    const r = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'],
      { timeout: 10_000 },
    );
    mergeHeadRef = r.stdout.trim();
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    const stderr = (e.stderr ?? '').trim();
    if (/not a git repository/i.test(stderr)) {
      return {
        ok: false,
        error: 'repo_not_found',
        message: `"${repoPath}" is not a git repository.`,
      };
    }
    // exit 1 with empty stderr = MERGE_HEAD doesn't exist (no merge in progress)
    if (e.code === 1) {
      return { ok: true, inProgress: false };
    }
    return {
      ok: false,
      error: 'git_error',
      message: `git rev-parse MERGE_HEAD failed: ${trimErr(err)}`,
    };
  }

  // Read HEAD ref for the response (useful for the UI to label
  // "ours" pane with the actual branch name later).
  let headRef = '';
  try {
    const r = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', 'HEAD'],
      { timeout: 10_000 },
    );
    headRef = r.stdout.trim();
  } catch (err) {
    return {
      ok: false,
      error: 'git_error',
      message: `git rev-parse HEAD failed: ${trimErr(err)}`,
    };
  }

  // List UU (both modified) files via `git status --porcelain=v2`.
  // The v2 format gives us a stable `u` line for unmerged entries:
  //   `u <X><Y> <sub> <mH> <mI> <mW> <hH> <hI> <hW> <path>`
  // We only need <path> and confirmation that it's unmerged.
  let porcelain = '';
  try {
    const r = await execFileAsync(
      'git',
      ['-C', repoPath, 'status', '--porcelain=v2', '-z'],
      { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
    );
    porcelain = r.stdout;
  } catch (err) {
    return {
      ok: false,
      error: 'git_error',
      message: `git status --porcelain=v2 failed: ${trimErr(err)}`,
    };
  }

  // Parse: -z separator is `\0`, lines start with `1 ` (changed),
  // `2 ` (renamed), `u ` (unmerged), `? ` (untracked), `! ` (ignored).
  // We only care about `u`. Per `git status --porcelain=v2` docs,
  // unmerged entries are:
  //   "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
  // That's 9 fields before <path>; <path> is parts[9] (0-indexed
  // after stripping the "u " prefix). Path may itself contain
  // spaces — `slice(9).join(' ')` reassembles it.
  const unmergedPaths: string[] = [];
  for (const rec of porcelain.split('\0')) {
    if (!rec.startsWith('u ')) continue;
    const parts = rec.slice(2).split(' ');
    if (parts.length < 10) continue;
    const path = parts.slice(9).join(' ');
    if (path) unmergedPaths.push(path);
  }

  const files: ConflictFileEntry[] = [];
  for (const p of unmergedPaths) {
    const entry = await readConflictFile(repoPath, p);
    files.push(entry);
  }

  return {
    ok: true,
    inProgress: true,
    mergeHeadRef,
    headRef,
    files,
  };
}

async function readConflictFile(
  repoPath: string,
  path: string,
): Promise<ConflictFileEntry> {
  // Read ours (stage :2) and theirs (stage :3) sides. Stage :1 is
  // the base — UI doesn't need it for 3-way display in v1 (VS
  // Code's "merge editor" shows base too, but we keep simpler 3-pane
  // ours/theirs/merged shape).
  const oursRead = await readGitStage(repoPath, 2, path);
  const theirsRead = await readGitStage(repoPath, 3, path);

  // Detect binary from either stage that reports it.
  const binary = oursRead.binary || theirsRead.binary;

  // Read working-tree content (with conflict markers). When the
  // file was deleted by one side, git may not write a working
  // tree file — fall back to empty string.
  let merged = '';
  try {
    const buf = readFileSync(join(repoPath, path));
    if (buf.length > FILE_CONTENT_BYTE_CAP) {
      // Truncate to cap, surface to UI via size hints. Caller can
      // refuse to edit beyond cap.
      merged = buf.slice(0, FILE_CONTENT_BYTE_CAP).toString('utf8');
    } else {
      merged = buf.toString('utf8');
    }
  } catch {
    merged = '';
  }

  return {
    path,
    binary,
    ours: binary ? null : oursRead.content,
    theirs: binary ? null : theirsRead.content,
    merged,
    oursSize: oursRead.size,
    theirsSize: theirsRead.size,
  };
}

interface StageReadResult {
  content: string | null;
  size: number | null;
  binary: boolean;
}

async function readGitStage(
  repoPath: string,
  stage: 1 | 2 | 3,
  path: string,
): Promise<StageReadResult> {
  // First check size via cat-file. Bail to size=null + binary=false
  // when the stage doesn't exist (e.g. one side added the file, the
  // other side doesn't have it — stage :2 or :3 missing).
  let size = 0;
  try {
    const r = await execFileAsync(
      'git',
      ['-C', repoPath, 'cat-file', '-s', `:${stage}:${path}`],
      { timeout: 10_000 },
    );
    size = Number(r.stdout.trim());
    if (!Number.isFinite(size)) size = 0;
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    if (e.code === 128 || /not a valid object name/i.test(e.stderr ?? '')) {
      return { content: null, size: null, binary: false };
    }
    return { content: null, size: null, binary: false };
  }
  if (size > FILE_CONTENT_BYTE_CAP) {
    return { content: null, size, binary: false };
  }
  try {
    const r = await execFileAsync(
      'git',
      ['-C', repoPath, 'show', `:${stage}:${path}`],
      {
        timeout: 30_000,
        maxBuffer: FILE_CONTENT_BYTE_CAP * 2,
        encoding: 'buffer',
      },
    );
    const buf = r.stdout as unknown as Buffer;
    // Heuristic binary detection: presence of a NUL byte in the
    // first 8KB. Same heuristic git itself uses.
    const sample = buf.subarray(0, Math.min(buf.length, 8192));
    const binary = sample.includes(0);
    if (binary) return { content: null, size, binary: true };
    return { content: buf.toString('utf8'), size, binary: false };
  } catch {
    return { content: null, size, binary: false };
  }
}

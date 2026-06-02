import { realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import type { ApplyResolutionResult, ConflictFileEntry } from './types.js';

/**
 * Path-traversal hardening (Codex P1.1 + P1.2) for applyResolution.
 *
 * Builds an allowlist from the CURRENT mid-merge UU files and runs
 * every caller-submitted path through three gates:
 *
 *   1. Path must be in the allowlist — no surprise additions
 *      (caller can't submit a previously-clean file).
 *   2. Path must NOT be flagged binary in the merge state — text
 *      writes corrupt binary content.
 *   3. Path must canonicalize (resolve()) to a location strictly
 *      inside repoPath — defence-in-depth in case the allowlist
 *      ever contains a path that, via symlink or `..`, escapes.
 *
 * Returns null when every submitted path is safe; returns a ready-
 * to-return `ApplyResolutionResult` rejection envelope otherwise.
 * Callers branch on the return value and short-circuit early.
 *
 * The HTTP body could submit `../../etc/passwd` — without this gate
 * `writeFileSync(join(repoPath, '../../etc/passwd'), ...)` would
 * write arbitrary content outside the repo.
 */
export function validateSubmittedPaths(args: {
  repoPath: string;
  resolvedFiles: Readonly<Record<string, string>>;
  files: readonly ConflictFileEntry[];
}): ApplyResolutionResult | null {
  const allowedByPath = new Map<string, ConflictFileEntry>();
  for (const f of args.files) allowedByPath.set(f.path, f);
  let repoRealpath: string;
  try {
    repoRealpath = realpathSync(args.repoPath);
  } catch {
    repoRealpath = resolve(args.repoPath);
  }
  const invalidPaths: string[] = [];
  const binaryPaths: string[] = [];
  for (const path of Object.keys(args.resolvedFiles)) {
    const entry = allowedByPath.get(path);
    if (!entry) {
      invalidPaths.push(path);
      continue;
    }
    if (entry.binary) {
      binaryPaths.push(path);
      continue;
    }
    // Canonical containment check. `resolve` does NOT follow
    // symlinks; we rely on the worktree's HEAD-tracked file list
    // being clean (git itself wouldn't track a symlink that
    // escapes the worktree), plus path normalization to reject
    // `..` traversal.
    const candidate = resolve(repoRealpath, path);
    const rel = relative(repoRealpath, candidate);
    if (rel.startsWith('..') || rel.includes(`..${sep}`) || rel === '' || rel.startsWith(sep)) {
      invalidPaths.push(path);
      continue;
    }
  }
  if (invalidPaths.length > 0) {
    return {
      ok: false,
      error: 'invalid_path',
      message: `${invalidPaths.length} submitted path(s) are not in the current conflict set OR resolve outside the repo: ${invalidPaths.map((p) => `\`${p}\``).join(', ')}. Only files reported by merge-conflict-prepare can be resolved.`,
      violatingPaths: invalidPaths,
    };
  }
  if (binaryPaths.length > 0) {
    return {
      ok: false,
      error: 'binary_conflict',
      message: `${binaryPaths.length} path(s) are binary conflicts and can't be text-merged: ${binaryPaths.map((p) => `\`${p}\``).join(', ')}. Resolve them in your terminal (\`git checkout --ours -- <path>\` or \`--theirs\`) and re-open the resolver.`,
      violatingPaths: binaryPaths,
    };
  }
  return null;
}

import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Detect whether the repo has an active pre-commit / commit-msg /
 * pre-merge-commit hook. Surfaces to the UI as an early warning —
 * if a hook rejects the merge commit, applyResolution returns
 * `commit_failed_merge_still_open` and the user has to either Retry
 * (after fixing the hook) or Abort.
 *
 * Returns the list of present hook names so the UI can name them
 * specifically ("`pre-commit` hook may reject the apply step"). A
 * file is "present" iff it exists, is regular (not a directory), and
 * is executable by the current process — matches how git itself
 * decides whether to run a hook. We also probe `core.hooksPath`
 * (git config setting that relocates the hooks dir).
 */
export function detectActiveCommitHooks(repoPath: string): {
  hooks: readonly string[];
  hooksDir: string | null;
} {
  // Resolve hooks directory: `core.hooksPath` override → otherwise
  // `<gitcommondir>/hooks`. Best-effort — silently return empty on
  // any failure.
  let hooksDir: string | null = null;
  try {
    const r = execFileSync(
      'git',
      ['-C', repoPath, 'config', '--get', 'core.hooksPath'],
      { encoding: 'utf8', timeout: 5_000 },
    );
    const v = r.trim();
    if (v.length > 0) {
      hooksDir = v.startsWith('/') ? v : join(repoPath, v);
    }
  } catch {
    // exit 1 = config key not set → fall through to git-common-dir.
  }
  if (!hooksDir) {
    try {
      const r = execFileSync(
        'git',
        ['-C', repoPath, 'rev-parse', '--git-common-dir'],
        { encoding: 'utf8', timeout: 5_000 },
      );
      const v = r.trim();
      const absolute = v.startsWith('/') ? v : join(repoPath, v);
      hooksDir = join(absolute, 'hooks');
    } catch {
      return { hooks: [], hooksDir: null };
    }
  }
  // Git runs these specific hook names during the commit pipeline.
  // Other hooks (post-commit, etc.) don't affect WHETHER the commit
  // lands so we don't surface them to the user.
  const RELEVANT = [
    'pre-commit',
    'prepare-commit-msg',
    'commit-msg',
    'pre-merge-commit',
  ];
  const found: string[] = [];
  for (const name of RELEVANT) {
    const p = join(hooksDir, name);
    try {
      if (!existsSync(p)) continue;
      // Use the executable-bit check — git only runs hooks that
      // are +x. A file present without exec bit is git's signal
      // "this hook is disabled".
      const st = statSync(p);
      if (!st.isFile()) continue;
      try {
        accessSync(p, fsConstants.X_OK);
      } catch {
        continue;
      }
      found.push(name);
    } catch {
      // Permission / stat error — skip.
    }
  }
  return { hooks: found, hooksDir };
}

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Deterministic handoff facts — "Mo = router, not narrator" epic.
 *
 * After a cli_agent stage finishes, the runner captures WHAT the stage
 * actually changed in the worktree — with code, not an LLM: a
 * `git diff --stat` against the pre-stage HEAD plus the changed-file
 * list (tracked + untracked). Downstream stages template it via
 * `{{stages.<id>.output.diffstat}}` / `.filesChanged` so reviewers /
 * docs / QA agents see facts instead of relying on the fixer's prose.
 *
 * Diffing against the PRE-STAGE sha (not plain HEAD) makes the capture
 * correct whether the agent committed its work or left it uncommitted:
 * `git diff <sha>` compares the working tree to that commit either way.
 *
 * Every operation is best-effort: any git failure (path isn't a repo,
 * git missing, timeout) yields null and the stage output simply omits
 * the fields — handoff enrichment must never fail a run.
 */

export interface WorktreeDiffResult {
  /** `git diff --stat` block (plus an untracked-files note), capped. */
  diffstat: string;
  /** Sorted unique repo-relative paths: tracked changes + untracked. */
  filesChanged: string[];
}

export interface WorktreeDiffCapture {
  /** Current HEAD sha of the worktree, or null when unresolvable. */
  headSha(worktreePath: string): Promise<string | null>;
  /** Changes of the working tree relative to `baseSha` (falls back to
   *  HEAD when null). Null when the path isn't a usable git worktree. */
  diffSince(
    worktreePath: string,
    baseSha: string | null,
  ): Promise<WorktreeDiffResult | null>;
}

const GIT_TIMEOUT_MS = 5_000;
/** Diffstat blocks are facts, but a 500-file diff would drown the
 *  prompt — cap with an explicit marker. */
const DIFFSTAT_CAP = 4_000;
const FILES_CAP = 200;

async function git(
  worktreePath: string,
  args: string[],
): Promise<string | null> {
  try {
    const result = await exec('git', ['-C', worktreePath, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    return result.stdout;
  } catch {
    return null;
  }
}

export const realWorktreeDiffCapture: WorktreeDiffCapture = {
  async headSha(worktreePath) {
    // Cheap fs gate before any git spawn: unit tests run workflows
    // against fabricated worktree paths, and a failed `git -C` spawn
    // still costs ~0.5s under the test harness — per cli_agent stage.
    if (!existsSync(worktreePath)) return null;
    const out = await git(worktreePath, ['rev-parse', 'HEAD']);
    const sha = out?.trim() ?? '';
    return sha.length > 0 ? sha : null;
  },

  async diffSince(worktreePath, baseSha) {
    if (!existsSync(worktreePath)) return null;
    const target = baseSha ?? 'HEAD';
    const diffstatRaw = await git(worktreePath, ['diff', '--stat', target]);
    if (diffstatRaw === null) return null;
    const namesRaw = (await git(worktreePath, ['diff', '--name-only', target])) ?? '';
    const statusRaw = (await git(worktreePath, ['status', '--porcelain'])) ?? '';
    const untracked = statusRaw
      .split('\n')
      .filter((line) => line.startsWith('??'))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    const filesChanged = [
      ...new Set([
        ...namesRaw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        ...untracked,
      ]),
    ]
      .sort()
      .slice(0, FILES_CAP);

    let diffstat = diffstatRaw.trim();
    if (untracked.length > 0) {
      diffstat = `${diffstat}${diffstat ? '\n' : ''}Untracked files: ${untracked.join(', ')}`;
    }
    if (diffstat.length > DIFFSTAT_CAP) {
      diffstat = `${diffstat.slice(0, DIFFSTAT_CAP)}\n… [diffstat truncated]`;
    }
    if (diffstat.length === 0 && filesChanged.length === 0) {
      return { diffstat: '(no file changes detected)', filesChanged: [] };
    }
    return { diffstat, filesChanged };
  },
};

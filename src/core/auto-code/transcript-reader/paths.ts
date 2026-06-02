/**
 * Path resolution for the Claude-projects transcript directory + per-session
 * file. Extracted from `../transcript-reader.ts` (2026-05-16, ticket
 * `01KRQYRTY348DAG9MM6JPMTDYR`).
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude Code stores per-cwd transcripts under
 * `~/.claude/projects/<encoded-cwd>/`. Encoding rule (verified
 * empirically against 0.x / 2.x sessions on macOS): every character
 * that isn't `[A-Za-z0-9-]` becomes `-`. So `/tmp/foo.bar/baz_qux`
 * encodes to `-tmp-foo-bar-baz-qux`.
 *
 * Note: the encoder does NOT collapse runs of `-`. `/.claude/`
 * encodes to `--claude-` because `/`+`.` are two separate chars
 * → two separate hyphens. This is essential — runs are how Claude
 * disambiguates path boundaries.
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * Resolve worktreeName + repoPath to the absolute claude-projects
 * directory holding that worktree's session transcripts. Honours
 * macOS `/tmp` → `/private/tmp` symlink resolution so the encoded
 * dir matches what Claude actually wrote (claude-cli internally
 * canonicalises before encoding).
 *
 * Returns null when the worktree dir doesn't exist on disk (the
 * caller's repoPath is wrong, OR the worktree was already cleaned
 * up by the orchestrator's terminal-state hook).
 */
export function transcriptDir(
  repoPath: string,
  worktreeName: string,
): string | null {
  // Worktrees moved from `.claude/worktrees/` → `.morion/worktrees/`
  // (2026-05-11). Try the new location first, then legacy. Claude
  // encodes the worktree absolute path into its projects/<encoded>
  // directory, so pre-rename runs still resolve via the legacy path.
  const candidates = [
    join(repoPath, '.morion', 'worktrees', worktreeName),
    join(repoPath, '.claude', 'worktrees', worktreeName),
  ];
  let canonical: string | null = null;
  for (const c of candidates) {
    try {
      canonical = realpathSync(c);
      break;
    } catch {
      // try next candidate
    }
  }
  if (!canonical) {
    // Worktree dir gone — claude-projects entry might still exist
    // (Claude doesn't sweep transcripts on worktree removal), so
    // fall back to symlink-resolved repoPath + relative join (try
    // both prefixes too).
    try {
      const repoReal = realpathSync(repoPath);
      // Prefer new location; legacy still readable if it's where
      // claude wrote the entry.
      canonical = join(repoReal, '.morion', 'worktrees', worktreeName);
    } catch {
      return null;
    }
  }
  const encoded = encodeCwdForClaudeProjects(canonical);
  return join(homedir(), '.claude', 'projects', encoded);
}

/**
 * Absolute path to the JSONL transcript for one session in one
 * worktree. Caller decides whether to check existence — we don't
 * stat here so the path can be passed straight to fs.watch.
 */
export function transcriptPath(
  repoPath: string,
  worktreeName: string,
  sessionId: string,
): string | null {
  const dir = transcriptDir(repoPath, worktreeName);
  if (!dir) return null;
  return join(dir, `${sessionId}.jsonl`);
}

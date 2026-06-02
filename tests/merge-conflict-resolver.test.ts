import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  abortMerge,
  applyResolution,
  detectActiveCommitHooks,
  readMergeConflictState,
} from '../src/core/auto-code/merge-conflict-resolver.js';
import { mergeWorktreeIntoTarget } from '../src/core/auto-code/merge.js';

/**
 * merge-conflict-resolver integration tests. The flow under test:
 *
 *   1. Build a repo with a real conflict between trunk and a worktree
 *      branch on the same file.
 *   2. Run mergeWorktreeIntoTarget({abortOnConflict: false}) — leaves
 *      MERGE_HEAD in place.
 *   3. readMergeConflictState() should return inProgress=true with the
 *      conflict file + its ours/theirs/merged content.
 *   4. applyResolution() should land a merge commit with the supplied
 *      resolved content.
 *   5. abortMerge() (separate path) should cleanup MERGE_HEAD.
 */

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function setupRepoWithConflict(): {
  repo: string;
  worktreeName: string;
} {
  const repo = mkdtempSync(join(tmpdir(), 'morion-conflict-resolver-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'tester@morion.local');
  git(repo, 'config', 'user.name', 'tester');
  writeFileSync(join(repo, 'game.js'), 'console.log("v1");\nconst score = 0;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');

  // Create worktree branch + edit game.js differently from main.
  const worktreeName = 'auto-test';
  git(repo, 'worktree', 'add', `.morion/worktrees/${worktreeName}`, '-b', worktreeName);
  const wtPath = join(repo, '.morion/worktrees', worktreeName);
  writeFileSync(
    join(wtPath, 'game.js'),
    'console.log("v1");\nconst score = 100; // feature side\n',
  );
  git(wtPath, 'add', '.');
  git(wtPath, 'commit', '-q', '-m', 'feature edit');

  // Edit main differently on the same line.
  writeFileSync(
    join(repo, 'game.js'),
    'console.log("v1");\nconst score = 42; // main side\n',
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'main edit');

  return { repo, worktreeName };
}

// Each test in this suite does multiple git ops on a fresh tmpdir
// repo (init + commits + worktree + merge + status reads). Under
// full-suite load these can take 6-15s per test; the vitest default
// 5s timeout flakes. 60s is generous + system-aware. (2026-05-12.)
describe('merge-conflict-resolver', { timeout: 60_000 }, () => {
  let repo: string;
  let worktreeName: string;

  beforeEach(() => {
    const setup = setupRepoWithConflict();
    repo = setup.repo;
    worktreeName = setup.worktreeName;
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  describe('readMergeConflictState', () => {
    it('returns inProgress=false when no merge is active', async () => {
      const state = await readMergeConflictState(repo);
      expect(state.ok).toBe(true);
      if (!state.ok) return;
      expect(state.inProgress).toBe(false);
    });

    it('returns inProgress=true with per-file ours/theirs/merged after a conflict-preserved merge', async () => {
      // Trigger conflict but preserve state (abortOnConflict: false).
      const r = await mergeWorktreeIntoTarget({
        repoPath: repo,
        worktreeName,
        strategy: 'no-ff',
        abortOnConflict: false,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe('merge_conflict');

      const state = await readMergeConflictState(repo);
      expect(state.ok).toBe(true);
      if (!state.ok) return;
      expect(state.inProgress).toBe(true);
      if (!state.inProgress) return;

      expect(state.files.length).toBe(1);
      const f = state.files[0]!;
      expect(f.path).toBe('game.js');
      expect(f.binary).toBe(false);
      expect(f.ours).toContain('main side');
      expect(f.theirs).toContain('feature side');
      // Merged working-tree content carries conflict markers.
      expect(f.merged).toContain('<<<<<<<');
      expect(f.merged).toContain('=======');
      expect(f.merged).toContain('>>>>>>>');
      // Cleanup so afterEach + other tests start fresh.
      await abortMerge(repo);
    });

    it('returns ok=false on a non-git path', async () => {
      const nonRepo = mkdtempSync(join(tmpdir(), 'morion-conflict-norepo-'));
      try {
        const state = await readMergeConflictState(nonRepo);
        expect(state.ok).toBe(false);
        if (state.ok) return;
        expect(state.error).toBe('repo_not_found');
      } finally {
        rmSync(nonRepo, { recursive: true, force: true });
      }
    });
  });

  describe('applyResolution', () => {
    it('lands a merge commit with the supplied resolved content', async () => {
      await mergeWorktreeIntoTarget({
        repoPath: repo,
        worktreeName,
        strategy: 'no-ff',
        abortOnConflict: false,
      });

      const resolvedContent =
        'console.log("v1");\nconst score = 100; // merged manually\n';
      const r = await applyResolution({
        repoPath: repo,
        resolvedFiles: { 'game.js': resolvedContent },
        commitMessage: 'Manual resolve: score = 100',
      });

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.resolved).toEqual(['game.js']);
      expect(r.sha).toMatch(/^[0-9a-f]{12}$/);

      // File content on disk == what we resolved.
      const fileContent = readFileSync(join(repo, 'game.js'), 'utf8');
      expect(fileContent).toBe(resolvedContent);

      // The new HEAD is a merge commit with 2 parents.
      const parents = git(repo, 'rev-parse', 'HEAD^@').trim().split('\n');
      expect(parents.length).toBe(2);

      // No merge in progress anymore.
      const post = await readMergeConflictState(repo);
      expect(post.ok).toBe(true);
      if (!post.ok) return;
      expect(post.inProgress).toBe(false);
    });

    it('strips `.morion-harness.lock` even when the agent baked it into the worktree commit (layer 3 defence)', async () => {
      // Setup: agent ran `git commit` inside worktree BEFORE the
      // lockfile was added to `.git/info/exclude` (back-compat shape
      // from worktrees created by older harness versions). Real
      // incident 2026-05-12 — Tetromino Eyes commit 65c550e had
      // `.morion-harness.lock` baked in; merge step lifted it to
      // trunk's index, and applyResolution would have written it
      // into the merge commit on `master`.
      const wtPath = join(repo, '.morion/worktrees', worktreeName);
      // The setup helper does `git add .` in trunk while `.morion/`
      // exists as a worktree dir → trunk's HEAD inadvertently tracks
      // a gitlink at `.morion/worktrees/auto-test`. Subsequent commits
      // on the worktree branch would then look like "modified
      // submodule" from trunk's POV → isWorkingTreeDirty=true. Strip
      // the gitlink so this test reflects the real production shape
      // (where the user's repo would have `.morion/` untracked or
      // .gitignore'd).
      try { git(repo, 'rm', '--cached', '-q', '.morion/worktrees/auto-test'); } catch { /* not tracked */ }
      try { git(repo, 'commit', '-q', '-m', 'untrack worktree gitlink'); } catch { /* nothing to commit */ }

      writeFileSync(
        join(wtPath, '.morion-harness.lock'),
        '{"pid":12345,"ownerToken":"secret-token"}',
      );
      git(wtPath, 'add', '.morion-harness.lock');
      git(wtPath, 'commit', '-q', '-m', 'agent commit with lockfile leak');

      // Trigger the conflict on game.js (already set up by
      // setupRepoWithConflict) AND propagate the lockfile to trunk
      // index. `mergeWorktreeIntoTarget` with abortOnConflict:false
      // preserves MERGE_HEAD so the resolver can run.
      const r = await mergeWorktreeIntoTarget({
        repoPath: repo,
        worktreeName,
        strategy: 'no-ff',
        abortOnConflict: false,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe('merge_conflict');

      // Sanity: lockfile is staged in trunk's index right now.
      const stagedBeforeApply = execFileSync(
        'git',
        ['-C', repo, 'diff', '--cached', '--name-only'],
        { encoding: 'utf8' },
      );
      expect(stagedBeforeApply).toContain('.morion-harness.lock');

      // Apply a resolution — the layer-3 defence MUST unstage the
      // lockfile so it doesn't ride along into trunk history.
      const applied = await applyResolution({
        repoPath: repo,
        resolvedFiles: {
          'game.js': 'console.log("v1");\nconst score = 50; // merged\n',
        },
      });
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;

      // The merge commit on trunk must NOT contain the lockfile.
      const headFiles = execFileSync(
        'git',
        ['-C', repo, 'show', '--name-only', '--pretty=format:', 'HEAD'],
        { encoding: 'utf8' },
      );
      expect(headFiles).not.toContain('.morion-harness.lock');
      // And the working tree no longer has it on disk.
      expect(existsSync(join(repo, '.morion-harness.lock'))).toBe(false);
    });

    it('refuses resolved content that still contains conflict markers', async () => {
      await mergeWorktreeIntoTarget({
        repoPath: repo,
        worktreeName,
        strategy: 'no-ff',
        abortOnConflict: false,
      });

      const r = await applyResolution({
        repoPath: repo,
        resolvedFiles: {
          'game.js':
            'console.log("v1");\n<<<<<<< HEAD\nconst score = 42;\n=======\nconst score = 100;\n>>>>>>> feature\n',
        },
      });

      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe('leftover_markers');
      expect(r.violatingPaths).toEqual(['game.js']);

      // Trunk should still be in conflict state — apply refused
      // BEFORE writing anything to disk.
      const state = await readMergeConflictState(repo);
      expect(state.ok).toBe(true);
      if (!state.ok) return;
      expect(state.inProgress).toBe(true);

      await abortMerge(repo);
    });

    it('rejects paths outside the current UU set (Codex P1.1 allowlist)', async () => {
      await mergeWorktreeIntoTarget({
        repoPath: repo,
        worktreeName,
        strategy: 'no-ff',
        abortOnConflict: false,
      });
      const r = await applyResolution({
        repoPath: repo,
        resolvedFiles: {
          'game.js': 'console.log("ok");\n',
          'README.md': '# pwned\n', // NOT in conflict set
        },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe('invalid_path');
      expect(r.violatingPaths).toContain('README.md');
      await abortMerge(repo);
    });

    it('rejects ../-traversal paths (Codex P1.1 path-traversal hardening)', async () => {
      await mergeWorktreeIntoTarget({
        repoPath: repo,
        worktreeName,
        strategy: 'no-ff',
        abortOnConflict: false,
      });
      const r = await applyResolution({
        repoPath: repo,
        resolvedFiles: {
          '../../etc/passwd': 'pwned\n',
        },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe('invalid_path');
      expect(r.violatingPaths).toEqual(['../../etc/passwd']);
      // /etc/passwd untouched (no write should have happened).
      // The real-system check is that we returned error BEFORE any
      // writeFileSync call — the violating path didn't even pass
      // the allowlist gate.
      await abortMerge(repo);
    });

    it('returns commit_failed_merge_still_open when pre-commit hook rejects the merge commit', async () => {
      // Install a pre-commit hook that always fails.
      const hookPath = join(repo, '.git/hooks/pre-commit');
      writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      execFileSync('chmod', ['+x', hookPath]);

      await mergeWorktreeIntoTarget({
        repoPath: repo,
        worktreeName,
        strategy: 'no-ff',
        abortOnConflict: false,
      });

      const r = await applyResolution({
        repoPath: repo,
        resolvedFiles: { 'game.js': 'console.log("resolved");\n' },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe('commit_failed_merge_still_open');
      // Preserved state — MERGE_HEAD still set, resolved content
      // still on disk + staged. UI can offer Retry / Abort.
      const status = git(repo, 'status', '--porcelain');
      // Note: after `git add`, game.js shows up as `M ` (staged-only).
      // We don't assert exact status — what matters is MERGE_HEAD lives.
      expect(status.length).toBeGreaterThan(0);
      expect(() => git(repo, 'rev-parse', '--verify', 'MERGE_HEAD')).not.toThrow();

      // The resolved content is on disk.
      const content = readFileSync(join(repo, 'game.js'), 'utf8');
      expect(content).toBe('console.log("resolved");\n');

      // Cleanup so other tests start fresh.
      await abortMerge(repo);
    });

    it('refuses when no merge is in progress', async () => {
      const r = await applyResolution({
        repoPath: repo,
        resolvedFiles: { 'game.js': 'whatever\n' },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe('no_merge_in_progress');
    });
  });

  describe('detectActiveCommitHooks', () => {
    it('returns empty list when no hooks are installed', () => {
      const r = detectActiveCommitHooks(repo);
      expect(r.hooks).toEqual([]);
    });

    it('detects an executable pre-commit hook', () => {
      const hookPath = join(repo, '.git/hooks/pre-commit');
      writeFileSync(hookPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      execFileSync('chmod', ['+x', hookPath]);
      const r = detectActiveCommitHooks(repo);
      expect(r.hooks).toContain('pre-commit');
    });

    it('ignores a pre-commit hook that lacks the executable bit (git would too)', () => {
      const hookPath = join(repo, '.git/hooks/pre-commit');
      writeFileSync(hookPath, '#!/bin/sh\nexit 0\n');
      execFileSync('chmod', ['-x', hookPath]);
      const r = detectActiveCommitHooks(repo);
      expect(r.hooks).not.toContain('pre-commit');
    });

    it('detects commit-msg + pre-merge-commit hooks too', () => {
      for (const name of ['commit-msg', 'pre-merge-commit']) {
        const p = join(repo, `.git/hooks/${name}`);
        writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        execFileSync('chmod', ['+x', p]);
      }
      const r = detectActiveCommitHooks(repo);
      expect(r.hooks).toContain('commit-msg');
      expect(r.hooks).toContain('pre-merge-commit');
    });

    it('returns empty list on a non-git path', () => {
      const nonRepo = mkdtempSync(join(tmpdir(), 'morion-hooks-norepo-'));
      try {
        const r = detectActiveCommitHooks(nonRepo);
        expect(r.hooks).toEqual([]);
      } finally {
        rmSync(nonRepo, { recursive: true, force: true });
      }
    });
  });

  describe('abortMerge', () => {
    it('cleans MERGE_HEAD + UU state when called mid-merge', async () => {
      await mergeWorktreeIntoTarget({
        repoPath: repo,
        worktreeName,
        strategy: 'no-ff',
        abortOnConflict: false,
      });

      // Confirm pre-state.
      const before = await readMergeConflictState(repo);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      expect(before.inProgress).toBe(true);

      const ab = await abortMerge(repo);
      expect(ab.ok).toBe(true);
      if (!ab.ok) return;
      expect(ab.aborted).toBe(true);

      // Trunk is clean.
      const status = git(repo, 'status', '--porcelain');
      expect(status).toBe('');

      // No merge.
      const after = await readMergeConflictState(repo);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.inProgress).toBe(false);
    });

    it('is a no-op when no merge is in progress', async () => {
      const r = await abortMerge(repo);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.aborted).toBe(false);
    });
  });

  describe('end-to-end: prepare → resolve → apply', () => {
    it('matches the conflict-resolver UI workflow', async () => {
      // 1. Prepare: merge with abortOnConflict=false.
      const merge = await mergeWorktreeIntoTarget({
        repoPath: repo,
        worktreeName,
        strategy: 'no-ff',
        abortOnConflict: false,
      });
      expect(merge.ok).toBe(false);

      // 2. Read state for the editor.
      const state = await readMergeConflictState(repo);
      expect(state.ok).toBe(true);
      if (!state.ok) return;
      expect(state.inProgress).toBe(true);
      if (!state.inProgress) return;

      // 3. User reviews ours/theirs, edits the merged content,
      //    submits the resolution.
      const resolved = (state.files[0]!.theirs ?? '').replace(
        '// feature side',
        '// merged by user (preferred feature side)',
      );

      // 4. Apply.
      const apply = await applyResolution({
        repoPath: repo,
        resolvedFiles: { [state.files[0]!.path]: resolved },
      });
      expect(apply.ok).toBe(true);
      if (!apply.ok) return;

      // 5. Trunk is clean + the merge commit landed with our text.
      const status = git(repo, 'status', '--porcelain');
      expect(status).toBe('');
      const content = readFileSync(join(repo, 'game.js'), 'utf8');
      expect(content).toContain('merged by user');
    });
  });
});

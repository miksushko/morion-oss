import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireWorktreeLock,
  ensureLockfileIgnored,
} from '../src/core/auto-code/harness/safety.js';

/**
 * Regression test for the Echo Drop incident (2026-05-11):
 * agent's `git add -A && git commit` swept up `.morion-harness.lock`
 * into commit `f44d3d0` alongside legitimate game.js changes,
 * leaking PID + runId + ownerToken into the user's git history.
 *
 * Layer 1 fix: `acquireWorktreeLock` writes the lockfile path to
 * `.git/info/exclude` of the repo, so `git add -A` skips it.
 * Layer 2 fix (separately tested in merge-worktree.test.ts): the
 * merge.ts auto-commit step explicitly unstages + unlinks the lock
 * file before committing.
 */

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

describe('harness lockfile gitignore (Echo Drop regression)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'morion-lockignore-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'tester@morion.local');
    git(repo, 'config', 'user.name', 'tester');
    writeFileSync(join(repo, 'game.js'), 'console.log("v1");\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  describe('ensureLockfileIgnored', () => {
    it('appends the rule to .git/info/exclude when missing', () => {
      ensureLockfileIgnored(repo);
      const exclude = readFileSync(join(repo, '.git/info/exclude'), 'utf8');
      expect(exclude).toMatch(/\/?\.morion-harness\.lock/);
    });

    it('is idempotent — running twice leaves a single rule', () => {
      ensureLockfileIgnored(repo);
      ensureLockfileIgnored(repo);
      const exclude = readFileSync(join(repo, '.git/info/exclude'), 'utf8');
      const occurrences = (exclude.match(/\.morion-harness\.lock/g) ?? []).length;
      expect(occurrences).toBe(1);
    });

    it('preserves any prior user-added exclude rules', () => {
      const excludePath = join(repo, '.git/info/exclude');
      mkdirSync(join(repo, '.git/info'), { recursive: true });
      writeFileSync(excludePath, '# user rules\n*.log\nscratch/\n');
      ensureLockfileIgnored(repo);
      const exclude = readFileSync(excludePath, 'utf8');
      expect(exclude).toContain('# user rules');
      expect(exclude).toContain('*.log');
      expect(exclude).toContain('scratch/');
      expect(exclude).toContain('.morion-harness.lock');
    });

    it('silently no-ops on a non-git path', () => {
      const nonRepo = mkdtempSync(join(tmpdir(), 'morion-lockignore-norepo-'));
      try {
        // Should not throw.
        ensureLockfileIgnored(nonRepo);
        // And should not create any .git/info/exclude shenanigans.
        expect(existsSync(join(nonRepo, '.git'))).toBe(false);
      } finally {
        rmSync(nonRepo, { recursive: true, force: true });
      }
    });
  });

  describe('acquireWorktreeLock → ensureLockfileIgnored → git add -A skips lockfile', () => {
    it('agent who runs `git add -A && git commit` does not commit the lockfile', () => {
      // Acquire lock — this should both write the lockfile AND
      // add it to .git/info/exclude.
      const lock = acquireWorktreeLock(repo, { runId: 'test-run' });
      try {
        expect(existsSync(lock.path)).toBe(true);

        // Simulate the agent's commit: edit some legit code, then
        // `git add -A && git commit`. The lockfile should NOT be
        // staged.
        writeFileSync(join(repo, 'game.js'), 'console.log("feature");\n');
        git(repo, 'add', '-A');

        // `git diff --cached --name-only` shows what's staged.
        const staged = git(repo, 'diff', '--cached', '--name-only').trim();
        expect(staged).toBe('game.js');
        expect(staged).not.toContain('.morion-harness.lock');

        // Commit + verify the lockfile is NOT in the resulting commit.
        git(repo, 'commit', '-q', '-m', 'feature');
        const headStat = git(repo, 'show', '--stat', 'HEAD');
        expect(headStat).toContain('game.js');
        expect(headStat).not.toContain('.morion-harness.lock');
      } finally {
        lock.release();
      }
    });
  });
});

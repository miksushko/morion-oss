import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  withRepoGitLock,
  _resetRepoGitLock,
} from '../src/core/auto-code/workflows/workflow-orchestrator/repo-git-lock.js';
import { defaultEnsureWorktree } from '../src/core/auto-code/workflows/workflow-orchestrator/helpers.js';

/**
 * Per-repo git-admin mutex — bug 2026-07-14 (5 tickets → todo at once
 * silently fail before the agent runs). Concurrent `git worktree add`
 * on one repo raced on the shared .git admin area; this lock serialises
 * them (mirrors the merge path's createRepoMergeLock).
 */

describe('withRepoGitLock', () => {
  beforeEach(() => _resetRepoGitLock());

  it('serialises concurrent callers on the same repo (no overlap)', async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const task = (n: number) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      order.push(n);
      active -= 1;
      return n;
    };
    const results = await Promise.all([
      withRepoGitLock('/repo/A', task(1)),
      withRepoGitLock('/repo/A', task(2)),
      withRepoGitLock('/repo/A', task(3)),
    ]);
    // Never two fns running at once on the same repo.
    expect(maxActive).toBe(1);
    // FIFO order preserved.
    expect(order).toEqual([1, 2, 3]);
    expect(results).toEqual([1, 2, 3]);
  });

  it('runs different repos in parallel (per-repo, not global)', async () => {
    let active = 0;
    let maxActive = 0;
    const task = () => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
    };
    await Promise.all([
      withRepoGitLock('/repo/A', task()),
      withRepoGitLock('/repo/B', task()),
    ]);
    expect(maxActive).toBe(2);
  });

  it('a rejected fn does not poison the next caller in the chain', async () => {
    const results: string[] = [];
    const p1 = withRepoGitLock('/repo/A', async () => {
      throw new Error('boom');
    }).catch(() => results.push('p1-rejected'));
    const p2 = withRepoGitLock('/repo/A', async () => {
      results.push('p2-ran');
    });
    await Promise.all([p1, p2]);
    expect(results).toContain('p1-rejected');
    expect(results).toContain('p2-ran');
  });
});

describe('defaultEnsureWorktree — concurrent worktree add on one repo', () => {
  let repoDir: string;

  beforeEach(() => {
    _resetRepoGitLock();
    repoDir = mkdtempSync(join(tmpdir(), 'morion-wtlock-'));
    const git = (args: string[]) =>
      execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 't@morion.local']);
    git(['config', 'user.name', 'T']);
    writeFileSync(join(repoDir, 'f.txt'), 'x\n');
    git(['add', '.']);
    git(['commit', '-qm', 'init']);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('creates 5 worktrees concurrently without a lock-contention failure', async () => {
    const names = ['auto-a', 'auto-b', 'auto-c', 'auto-d', 'auto-e'];
    const results = await Promise.allSettled(
      names.map((n) =>
        defaultEnsureWorktree({
          repoPath: repoDir,
          worktreeName: n,
          worktreePath: join(repoDir, '.wt', n),
        }),
      ),
    );
    // Every worktree add succeeded — the lock serialised the .git
    // admin-area mutations. Before the fix, concurrent `worktree add`
    // could reject with a config.lock / HEAD.lock error.
    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }
    for (const n of names) {
      expect(existsSync(join(repoDir, '.wt', n))).toBe(true);
    }
    // git agrees all 5 worktrees are registered (+ the main one).
    const list = execFileSync('git', ['-C', repoDir, 'worktree', 'list'], {
      encoding: 'utf8',
    });
    expect(list.trim().split('\n').length).toBe(6);
  });
});

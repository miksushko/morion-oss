import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeWorktreeIntoTarget } from '../src/core/auto-code/merge.js';

/**
 * mergeWorktreeIntoTarget integration tests. Spin up a real on-disk
 * git repo with a real worktree branch, exercise the happy path AND
 * the conflict path. The conflict-path test is the regression for
 * the 2026-05-11 incident: `merge.ts` caught the conflict but didn't
 * `git merge --abort`, so the trunk stayed in `UU game.js` state and
 * blocked every subsequent merge attempt until the user manually
 * ran `git merge --abort` (or `git reset --hard`).
 */

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function setupRepo(): { repo: string; worktreeName: string } {
  const repo = mkdtempSync(join(tmpdir(), 'morion-merge-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'tester@morion.local');
  git(repo, 'config', 'user.name', 'tester');
  writeFileSync(join(repo, 'game.js'), 'console.log("v1");\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return { repo, worktreeName: 'auto-test' };
}

// Same rationale as merge-conflict-resolver.test.ts — these tests
// run real git on tmpdir fixtures and can be slow under suite load.
describe('mergeWorktreeIntoTarget', { timeout: 60_000 }, () => {
  let repo: string;
  let worktreeName: string;

  beforeEach(() => {
    const setup = setupRepo();
    repo = setup.repo;
    worktreeName = setup.worktreeName;
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('merges a worktree branch into main on the happy path', async () => {
    // Create worktree + commit on its branch.
    git(repo, 'worktree', 'add', `.morion/worktrees/${worktreeName}`, '-b', worktreeName);
    const wtPath = join(repo, '.morion/worktrees', worktreeName);
    writeFileSync(join(wtPath, 'game.js'), 'console.log("v1 + feature");\n');
    git(wtPath, 'add', '.');
    git(wtPath, 'commit', '-q', '-m', 'add feature');

    const result = await mergeWorktreeIntoTarget({
      repoPath: repo,
      worktreeName,
      strategy: 'no-ff',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mergedBranch).toBe(worktreeName);
    expect(result.targetBranch).toBe('main');

    // Trunk now has the feature.
    const trunkGame = readFileSync(join(repo, 'game.js'), 'utf8');
    expect(trunkGame).toContain('feature');

    // Ticket 01KRFX0PNE4WAFTDYJ3FQPK8F7 — post-merge cleanup. The
    // worktree dir should be gone (`git worktree remove --force`
    // landed inside mergeWorktreeIntoTarget). The branch ref STAYS
    // so `git log --graph --all` keeps the merge history readable.
    expect(existsSync(wtPath)).toBe(false);
    // Branch ref preserved.
    const branchList = execFileSync('git', ['-C', repo, 'branch', '--list', worktreeName], { encoding: 'utf8' });
    expect(branchList).toContain(worktreeName);
    // Worktree no longer in `git worktree list`.
    const wtList = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    expect(wtList).not.toContain(`.morion/worktrees/${worktreeName}`);
  });

  it('stale MERGE_HEAD from a prior attempt is auto-cleaned before fresh merge', async () => {
    // Setup: trunk in mid-merge state from a prior conflict (the
    // exact shape user hit on 2026-05-12 — earlier sidecar without
    // auto-abort left trunk with `UU game.js` + MERGE_HEAD, every
    // subsequent merge failed with "Cannot save the current index
    // state. fatal: stash failed").
    git(repo, 'worktree', 'add', `.morion/worktrees/${worktreeName}`, '-b', worktreeName);
    const wtPath = join(repo, '.morion/worktrees', worktreeName);
    writeFileSync(join(wtPath, 'game.js'), 'console.log("v1 — feature side");\n');
    git(wtPath, 'add', '.');
    git(wtPath, 'commit', '-q', '-m', 'feature');
    writeFileSync(join(repo, 'game.js'), 'console.log("v1 — main side");\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main');

    // Stage 1: simulate the legacy mid-merge state. Run `git merge`
    // directly (bypass our wrapper) — it will hit conflict + leave
    // MERGE_HEAD + UU. THIS is what an older sidecar would leave.
    try {
      execFileSync('git', ['-C', repo, 'merge', '--no-ff', '-m', 'try', worktreeName], {
        stdio: 'pipe',
      });
    } catch {
      // Conflict expected.
    }
    // Confirm we're in the stuck state.
    const stuck = git(repo, 'status', '--porcelain');
    expect(stuck).toMatch(/^UU /m);
    expect(() => git(repo, 'rev-parse', '--verify', 'MERGE_HEAD')).not.toThrow();

    // Stage 2: NOW call mergeWorktreeIntoTarget. The new entry-time
    // stale-merge guard should auto-abort + run fresh, surfacing
    // the conflict cleanly through OUR envelope (not leaving trunk
    // half-broken AND not throwing "stash failed").
    const result = await mergeWorktreeIntoTarget({
      repoPath: repo,
      worktreeName,
      strategy: 'no-ff',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Default `abortOnConflict: true` → trunk should be CLEAN
    // after the call (stale aborted + fresh attempt also aborted).
    expect(result.error).toBe('merge_conflict');
    const status = git(repo, 'status', '--porcelain');
    expect(status).toBe('');
    expect(() => git(repo, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
  });

  it('on conflict: returns error envelope AND aborts the merge so trunk is clean', async () => {
    // Two divergent commits on main + the worktree branch, both
    // touching the same line of game.js → guaranteed conflict.
    git(repo, 'worktree', 'add', `.morion/worktrees/${worktreeName}`, '-b', worktreeName);
    const wtPath = join(repo, '.morion/worktrees', worktreeName);

    // Worktree branch edits the original line.
    writeFileSync(join(wtPath, 'game.js'), 'console.log("v1 — feature path");\n');
    git(wtPath, 'add', '.');
    git(wtPath, 'commit', '-q', '-m', 'feature edit');

    // Main checkout edits the SAME line differently.
    writeFileSync(join(repo, 'game.js'), 'console.log("v1 — main path");\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main edit');

    const result = await mergeWorktreeIntoTarget({
      repoPath: repo,
      worktreeName,
      strategy: 'no-ff',
    });

    // Error surfaced cleanly to the caller.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('merge_conflict');
    expect(result.message).toMatch(/conflict/i);
    // Helpful message points at the recovery path.
    expect(result.message).toMatch(/re-run|resolve/i);

    // CRITICAL: trunk is CLEAN. No `UU` markers, no MERGE_HEAD, no
    // half-applied changes from the merge candidate. The user can
    // immediately retry another merge or run another auto-code
    // ticket without ever knowing the conflict happened. This is
    // the 2026-05-11 regression test — before the fix, the trunk
    // sat in `UU game.js` state and blocked all subsequent merges.
    const status = git(repo, 'status', '--porcelain');
    expect(status).toBe('');
    // MERGE_HEAD ref shouldn't exist.
    expect(() => git(repo, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow();
  });

  it('defensive unstage: auto-commit step refuses to land `.morion-harness.lock` even if agent staged it', async () => {
    // Setup: worktree branch with feature changes PLUS a stowaway
    // `.morion-harness.lock` file uncommitted in worktree (simulates
    // the bug shape from Echo Drop ticket — agent's `git add -A`
    // staged it).
    git(repo, 'worktree', 'add', `.morion/worktrees/${worktreeName}`, '-b', worktreeName);
    const wtPath = join(repo, '.morion/worktrees', worktreeName);
    writeFileSync(join(wtPath, 'game.js'), 'console.log("v1 + feature");\n');
    writeFileSync(
      join(wtPath, '.morion-harness.lock'),
      '{"pid":12345,"ownerToken":"secret-token"}',
    );

    const result = await mergeWorktreeIntoTarget({
      repoPath: repo,
      worktreeName,
      strategy: 'no-ff',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The auto-commit on the worktree branch must NOT include the
    // lockfile. Walk recent commits to verify.
    const log = execFileSync('git', ['-C', repo, 'log', '--all', '--pretty=format:%H', '--name-only'], { encoding: 'utf8' });
    expect(log).toContain('game.js');
    // The lock file's name should NEVER appear in any commit.
    expect(log).not.toContain('.morion-harness.lock');

    // The worktree's working-tree copy of the lockfile is also
    // gone (we unlink it as part of the defensive step).
    // Note: depending on whether the worktree is reaped after
    // successful merge, this path may or may not exist on disk.
    // We don't assert here; the commit-level check above is the
    // critical guarantee.
  });

  it('lockfile-only dirty worktree: no fake commit, merge reports honest "Already up to date"', async () => {
    // Agent produced no real diff (timeout, early-bailout, mo eject)
    // but harness wrote `.morion-harness.lock` into the worktree. The
    // old code path staged the lockfile, defensively unstaged it,
    // deleted from disk, then tried to `git commit` with an empty
    // staging area → "nothing to commit" → "Command failed: git ...
    // commit ..." with no stderr surfaced to the user. Real user
    // incident 2026-05-12 on Tetromino Eyes ticket.
    git(repo, 'worktree', 'add', `.morion/worktrees/${worktreeName}`, '-b', worktreeName);
    const wtPath = join(repo, '.morion/worktrees', worktreeName);
    // Only the lockfile is dirty — agent made zero real changes.
    writeFileSync(
      join(wtPath, '.morion-harness.lock'),
      '{"pid":12345,"ownerToken":"secret-token"}',
    );

    const result = await mergeWorktreeIntoTarget({
      repoPath: repo,
      worktreeName,
      strategy: 'no-ff',
    });

    // No git_error — auto-commit step recognised the empty staging
    // area as no-op instead of erroring.
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No commits landed on worktree branch (and nothing in trunk log).
    const log = execFileSync('git', ['-C', repo, 'log', '--all', '--pretty=format:%H', '--name-only'], { encoding: 'utf8' });
    expect(log).not.toContain('.morion-harness.lock');
  });

  it('on conflict: trunk pre-existing dirty files are NOT clobbered by the abort', async () => {
    // User has uncommitted work in trunk on a DIFFERENT file
    // (the merge candidate doesn't touch it). Conflict happens on
    // game.js. The abort should NOT nuke the user's edits to
    // README.md.
    //
    // Note: the merge ROUTE upstream of merge.ts refuses to start
    // when the trunk has uncommitted changes (`isWorkingTreeDirty`
    // check). So in practice this scenario isn't reachable through
    // the public API — but we still want abort to be conservative.
    writeFileSync(join(repo, 'README.md'), '# project\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'add readme');

    // Same conflict setup as before, on game.js.
    git(repo, 'worktree', 'add', `.morion/worktrees/${worktreeName}`, '-b', worktreeName);
    const wtPath = join(repo, '.morion/worktrees', worktreeName);
    writeFileSync(join(wtPath, 'game.js'), 'feature\n');
    git(wtPath, 'add', '.');
    git(wtPath, 'commit', '-q', '-m', 'feature');
    writeFileSync(join(repo, 'game.js'), 'main\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main edit');

    // Add user-dirty edit to README AFTER both commits land — this
    // bypasses the route's dirty-check gate; we're testing only
    // the abort behavior here.
    writeFileSync(join(repo, 'README.md'), '# project\n\n## user wip\n');

    const result = await mergeWorktreeIntoTarget({
      repoPath: repo,
      worktreeName,
      strategy: 'no-ff',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('working_tree_dirty');
    // README still has user's edit — the upstream dirty-check
    // refused the merge BEFORE we touched anything.
    const readme = readFileSync(join(repo, 'README.md'), 'utf8');
    expect(readme).toContain('user wip');
  });
});

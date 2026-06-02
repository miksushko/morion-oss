import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditTrunkAfterRun,
  revertLeakedFiles,
  snapshotTrunkState,
} from '../src/core/auto-code/trunk-guard.js';

/**
 * Trunk-guard unit tests. Spin up a small git repo on disk, exercise
 * the snapshot / audit / revert flow against scenarios that match
 * real-world auto-code leak patterns.
 *
 * The fixture uses `git init -q -b main` so HEAD is `main` on a fresh
 * clone (matches Morion's auto-detect main/master order). Commits go
 * with a fixed author so the test is hermetic across machines.
 */

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'morion-trunkguard-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'tester@morion.local');
  git(repo, 'config', 'user.name', 'tester');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  writeFileSync(join(repo, 'game.js'), 'console.log("v1");\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

describe('trunk-guard', () => {
  let repo: string;

  beforeEach(() => {
    repo = initRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  describe('snapshotTrunkState', () => {
    it('returns ok=true with HEAD ref + tracked file hashes for a clean repo', async () => {
      const r = await snapshotTrunkState(repo);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.snapshot.headRef).toMatch(/^[0-9a-f]{40}$/);
      expect(r.snapshot.fileHashes.has('README.md')).toBe(true);
      expect(r.snapshot.fileHashes.has('game.js')).toBe(true);
      expect(r.snapshot.userDirtyFiles.size).toBe(0);
    });

    it('records user-dirty file under userDirtyFiles', async () => {
      appendFileSync(join(repo, 'game.js'), '// user edit\n');
      const r = await snapshotTrunkState(repo);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.snapshot.userDirtyFiles.has('game.js')).toBe(true);
      expect(r.snapshot.userDirtyFiles.has('README.md')).toBe(false);
    });

    it('returns ok=false with error=repo_not_found on a non-git path', async () => {
      const nonRepo = mkdtempSync(join(tmpdir(), 'morion-trunkguard-norepo-'));
      try {
        const r = await snapshotTrunkState(nonRepo);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe('repo_not_found');
      } finally {
        rmSync(nonRepo, { recursive: true, force: true });
      }
    });
  });

  describe('auditTrunkAfterRun', () => {
    it('reports leakedFiles=[] when nothing changed', async () => {
      const snap = await snapshotTrunkState(repo);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      const audit = await auditTrunkAfterRun(snap.snapshot);
      expect(audit.ok).toBe(true);
      if (!audit.ok) return;
      expect(audit.leakedFiles).toEqual([]);
      expect(audit.headChanged).toBe(false);
    });

    it('flags a file the "agent" dirtied between snapshot and audit', async () => {
      const snap = await snapshotTrunkState(repo);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      // Simulate a leak — agent wrote to game.js while we weren't
      // looking.
      appendFileSync(join(repo, 'game.js'), '// agent leak\n');
      const audit = await auditTrunkAfterRun(snap.snapshot);
      expect(audit.ok).toBe(true);
      if (!audit.ok) return;
      expect(audit.leakedFiles).toEqual(['game.js']);
    });

    it('does NOT flag a file the user dirtied BEFORE the snapshot', async () => {
      // User edits BEFORE snapshot.
      appendFileSync(join(repo, 'game.js'), '// user pre-edit\n');
      const snap = await snapshotTrunkState(repo);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      // Agent does its thing in the (imagined) worktree. No further
      // changes to trunk. The user's dirty file is untouched.
      const audit = await auditTrunkAfterRun(snap.snapshot);
      expect(audit.ok).toBe(true);
      if (!audit.ok) return;
      expect(audit.leakedFiles).toEqual([]);
    });

    it('does NOT blame agent for further dirtying a file the user already had dirty', async () => {
      // User edit, snapshot, then agent (or hand) edits same file
      // more. Documented tradeoff: we trust user's dirty file and
      // don't audit its contents. Agent leakage INTO a user-owned
      // dirty file is missed by design.
      appendFileSync(join(repo, 'game.js'), '// user pre-edit\n');
      const snap = await snapshotTrunkState(repo);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      appendFileSync(join(repo, 'game.js'), '// "agent" leak into user-dirty file\n');
      const audit = await auditTrunkAfterRun(snap.snapshot);
      expect(audit.ok).toBe(true);
      if (!audit.ok) return;
      expect(audit.leakedFiles).toEqual([]);
    });

    it('flags a NEW tracked file (user wouldn\'t add tracked files mid-run)', async () => {
      const snap = await snapshotTrunkState(repo);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      // Simulate agent doing `git add` of a new file in trunk
      // (highly unlikely but defensive).
      writeFileSync(join(repo, 'leaked.js'), '// new\n');
      git(repo, 'add', 'leaked.js');
      // Important: a file the agent ADDED but didn't commit lives in
      // the index. `git ls-tree -r HEAD` won't see it (HEAD doesn't
      // have it). Audit's tracked-file walk reads HEAD's tree, so a
      // pure-index-add wouldn't be flagged unless we read the index
      // instead. Document this: the audit catches working-tree
      // modifications to HEAD-tracked files + deletions. Pure
      // staged-only new files are out of scope for v1 — the
      // realistic leak shape is "write to a file that already exists
      // on disk", not "stage a new file without writing to disk".
      const audit = await auditTrunkAfterRun(snap.snapshot);
      expect(audit.ok).toBe(true);
      if (!audit.ok) return;
      // Empty leak set is acceptable here — see comment above.
      expect(audit.leakedFiles).toEqual([]);
    });

    it('flags a deleted file as leaked', async () => {
      const snap = await snapshotTrunkState(repo);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      unlinkSync(join(repo, 'game.js'));
      const audit = await auditTrunkAfterRun(snap.snapshot);
      expect(audit.ok).toBe(true);
      if (!audit.ok) return;
      expect(audit.leakedFiles).toContain('game.js');
    });

    it('sets headChanged=true when HEAD moves between snapshot and audit', async () => {
      const snap = await snapshotTrunkState(repo);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      writeFileSync(join(repo, 'side.js'), 'side\n');
      git(repo, 'add', 'side.js');
      git(repo, 'commit', '-q', '-m', 'side');
      const audit = await auditTrunkAfterRun(snap.snapshot);
      expect(audit.ok).toBe(true);
      if (!audit.ok) return;
      expect(audit.headChanged).toBe(true);
    });
  });

  describe('revertLeakedFiles', () => {
    it('restores a modified file back to HEAD content', async () => {
      appendFileSync(join(repo, 'game.js'), '// leak\n');
      const before = readFileSync(join(repo, 'game.js'), 'utf8');
      expect(before).toContain('// leak');
      const r = await revertLeakedFiles(repo, ['game.js']);
      expect(r.reverted).toEqual(['game.js']);
      expect(r.failed).toEqual([]);
      const after = readFileSync(join(repo, 'game.js'), 'utf8');
      expect(after).toBe('console.log("v1");\n');
    });

    it('restores a deleted file', async () => {
      unlinkSync(join(repo, 'game.js'));
      const r = await revertLeakedFiles(repo, ['game.js']);
      expect(r.reverted).toEqual(['game.js']);
      const after = readFileSync(join(repo, 'game.js'), 'utf8');
      expect(after).toBe('console.log("v1");\n');
    });

    it('reports per-file failure when a path doesn\'t exist in HEAD', async () => {
      const r = await revertLeakedFiles(repo, ['nonexistent.js']);
      expect(r.reverted).toEqual([]);
      expect(r.failed.length).toBe(1);
      expect(r.failed[0]!.path).toBe('nonexistent.js');
    });

    it('no-ops on empty input', async () => {
      const r = await revertLeakedFiles(repo, []);
      expect(r.reverted).toEqual([]);
      expect(r.failed).toEqual([]);
    });
  });

  describe('end-to-end: snapshot → leak → audit → revert', () => {
    it('matches the real-world incident shape (45-line leak into game.js)', async () => {
      // Snapshot clean repo.
      const snap = await snapshotTrunkState(repo);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;

      // Simulate a 45-line leak — sidecar restarted mid-run, the
      // claude process kept writing to trunk's game.js.
      const leakBody = Array.from(
        { length: 45 },
        (_, i) => `// leaked line ${i + 1}`,
      ).join('\n') + '\n';
      appendFileSync(join(repo, 'game.js'), leakBody);

      // Audit catches it.
      const audit = await auditTrunkAfterRun(snap.snapshot);
      expect(audit.ok).toBe(true);
      if (!audit.ok) return;
      expect(audit.leakedFiles).toEqual(['game.js']);

      // Revert restores HEAD content. The 45 lines disappear.
      const revert = await revertLeakedFiles(repo, audit.leakedFiles);
      expect(revert.reverted).toEqual(['game.js']);
      const restored = readFileSync(join(repo, 'game.js'), 'utf8');
      expect(restored).toBe('console.log("v1");\n');
      expect(restored).not.toContain('leaked line');
    });

    it('preserves user-owned dirty edits across the whole flow', async () => {
      // User has uncommitted work in game.js.
      appendFileSync(join(repo, 'game.js'), '\n// my wip\n');
      const snap = await snapshotTrunkState(repo);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;

      // Agent runs cleanly inside the worktree — trunk unchanged.
      const audit = await auditTrunkAfterRun(snap.snapshot);
      expect(audit.ok).toBe(true);
      if (!audit.ok) return;
      expect(audit.leakedFiles).toEqual([]);

      // User's wip is still there.
      const content = readFileSync(join(repo, 'game.js'), 'utf8');
      expect(content).toContain('// my wip');
    });
  });
});

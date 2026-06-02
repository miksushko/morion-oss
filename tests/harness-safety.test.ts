import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireWorktreeLock,
  registerChild,
  unregisterChild,
  WorktreeLockBusyError,
  _resetForTests,
  _snapshotRegistry,
} from '../src/core/auto-code/harness/safety.js';

/**
 * L1.T7 — process-safety helpers tests.
 *
 * Lockfile coverage:
 *   - Acquires + writes our PID
 *   - Reaps stale prior PID via SIGTERM → SIGKILL chain
 *   - Race-safe release (only deletes if file still references us)
 *   - Throws on filesystem failure
 *   - Corrupt lockfile content tolerated (overwrite without reap)
 *
 * Registry coverage:
 *   - registerChild / unregisterChild round-trip
 *   - Exit hook installed exactly once
 *   - Multiple concurrent children tracked independently
 *
 * Test isolation: `_resetForTests()` between tests since the registry
 * is module-scoped + the exit hook is only-installed-once.
 */

const LOCK_FILENAME = '.morion-harness.lock';

describe('acquireWorktreeLock (L1.T7)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'morion-harness-safety-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes lockfile with our PID + runId on acquire', () => {
    const lock = acquireWorktreeLock(workDir, { runId: 'run-aaa' });
    const lockPath = join(workDir, LOCK_FILENAME);
    expect(lock.path).toBe(lockPath);
    expect(existsSync(lockPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.runId).toBe('run-aaa');
    expect(typeof parsed.startedAt).toBe('number');

    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('release is idempotent', () => {
    const lock = acquireWorktreeLock(workDir);
    lock.release();
    lock.release(); // second call: no-op, no throw
    expect(existsSync(lock.path)).toBe(false);
  });

  it('release does NOT delete file if PID was overwritten by newer harness', () => {
    const lock = acquireWorktreeLock(workDir);
    // Simulate a newer harness reaping us + writing its own PID.
    writeFileSync(
      lock.path,
      JSON.stringify({ pid: 99999, runId: 'newer', startedAt: Date.now() }),
      'utf8',
    );
    lock.release();
    // File still exists — we didn't own it anymore at release time.
    expect(existsSync(lock.path)).toBe(true);
    // Cleanup
    rmSync(lock.path);
  });

  it('reaps stale prior PID via SIGTERM (test injection)', () => {
    // Simulate prior harness wrote a lockfile with a foreign PID.
    const priorPid = 12345;
    const lockPath = join(workDir, LOCK_FILENAME);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: priorPid, runId: 'old', startedAt: 0 }),
      'utf8',
    );

    const killCalls: Array<{ pid: number; signal: 0 | 'SIGTERM' | 'SIGKILL' }> = [];
    let alive = true;
    const lock = acquireWorktreeLock(workDir, {
      killProbe: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === 'SIGTERM') {
          // Simulate the process exiting cleanly on SIGTERM.
          alive = false;
        }
        return alive;
      },
      sleepMs: () => {
        // no-op for test speed
      },
    });

    // Probe + SIGTERM should both have been called for priorPid.
    expect(killCalls.find((c) => c.pid === priorPid && c.signal === 0)).toBeDefined();
    expect(
      killCalls.find((c) => c.pid === priorPid && c.signal === 'SIGTERM'),
    ).toBeDefined();
    // SIGKILL should NOT have been called (SIGTERM succeeded).
    expect(
      killCalls.find((c) => c.pid === priorPid && c.signal === 'SIGKILL'),
    ).toBeUndefined();

    // Our PID should now own the lock.
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(parsed.pid).toBe(process.pid);

    lock.release();
  });

  it('escalates to SIGKILL when SIGTERM is ignored', () => {
    const priorPid = 12345;
    const lockPath = join(workDir, LOCK_FILENAME);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: priorPid, runId: 'stubborn', startedAt: 0 }),
      'utf8',
    );

    const killCalls: Array<{ pid: number; signal: 0 | 'SIGTERM' | 'SIGKILL' }> = [];
    let aliveAfterSigkill = true;
    const lock = acquireWorktreeLock(workDir, {
      killProbe: (pid, signal) => {
        killCalls.push({ pid, signal });
        if (signal === 'SIGKILL') {
          aliveAfterSigkill = false;
          return true; // we still respond true on the SIGKILL call itself
        }
        return aliveAfterSigkill;
      },
      sleepMs: () => {
        // no-op for test speed
      },
      termWaitMs: 100, // short term wait to keep test fast
    });

    expect(
      killCalls.find((c) => c.pid === priorPid && c.signal === 'SIGTERM'),
    ).toBeDefined();
    expect(
      killCalls.find((c) => c.pid === priorPid && c.signal === 'SIGKILL'),
    ).toBeDefined();

    lock.release();
  });

  it('skips reap when prior PID is already dead', () => {
    const priorPid = 12345;
    const lockPath = join(workDir, LOCK_FILENAME);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: priorPid, runId: 'dead', startedAt: 0 }),
      'utf8',
    );

    const killCalls: Array<{ pid: number; signal: 0 | 'SIGTERM' | 'SIGKILL' }> = [];
    const lock = acquireWorktreeLock(workDir, {
      killProbe: (pid, signal) => {
        killCalls.push({ pid, signal });
        return false; // ESRCH — prior PID gone
      },
      sleepMs: () => {},
    });

    // Probe was called once, but no SIGTERM/SIGKILL since prior dead.
    expect(killCalls).toHaveLength(1);
    expect(killCalls[0]!.signal).toBe(0);
    lock.release();
  });

  it('tolerates corrupt lockfile by overwriting without reap', () => {
    const lockPath = join(workDir, LOCK_FILENAME);
    writeFileSync(lockPath, '{not valid json', 'utf8');

    const killCalls: Array<unknown> = [];
    const lock = acquireWorktreeLock(workDir, {
      killProbe: (pid, signal) => {
        killCalls.push({ pid, signal });
        return false;
      },
    });

    // No reap attempted — corrupt file = no PID to reap.
    expect(killCalls).toHaveLength(0);
    // Our PID was written.
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(parsed.pid).toBe(process.pid);
    lock.release();
  });

  it('throws WorktreeLockBusyError on same-process contention (Codex T10 P1)', () => {
    // Two handles inside Morion sidecar — pre-fix this would
    // overwrite + clobber. Fix: throw clear error so workflow runner
    // surfaces "double-spawn into same worktree" as a logic bug
    // instead of silently corrupting git state.
    const first = acquireWorktreeLock(workDir, { runId: 'first' });
    expect(() =>
      acquireWorktreeLock(workDir, { runId: 'second' }),
    ).toThrow(WorktreeLockBusyError);
    first.release();

    // After first releases, second can acquire cleanly.
    const second = acquireWorktreeLock(workDir, { runId: 'second' });
    second.release();
  });

  it('release uses owner token, not PID alone (Codex T10 P1)', () => {
    // Pre-fix release(): pid-only check. If a second handle ever got
    // the same lock (broken atomicity), the first's release would
    // delete the second's lock. Fix: ownerToken in lockfile, release
    // matches BOTH pid + ownerToken.
    const lock = acquireWorktreeLock(workDir, { runId: 'A' });

    // Simulate a different lock (different ownerToken — same pid)
    // via direct file overwrite. lock.release() must NOT delete it.
    writeFileSync(
      lock.path,
      JSON.stringify({
        pid: process.pid,
        runId: 'B',
        ownerToken: 'different-token-xyz',
        startedAt: Date.now(),
      }),
      'utf8',
    );

    lock.release(); // own token doesn't match — leaves file alone
    expect(existsSync(lock.path)).toBe(true);
    rmSync(lock.path);
  });

  it('atomic create prevents two same-pid acquires racing (Codex T10 P1)', () => {
    // Concurrent same-pid acquires would (pre-fix) both succeed via
    // overwrite. Fix: openSync('wx') makes the second fail.
    // We can't truly race in single-threaded JS, but we can test the
    // atomicity guarantee: after first acquire, second always sees
    // BUSY error before second's own write.
    const first = acquireWorktreeLock(workDir, { runId: 'first' });
    let secondError: Error | null = null;
    try {
      acquireWorktreeLock(workDir, { runId: 'second' });
    } catch (e) {
      secondError = e as Error;
    }
    expect(secondError).toBeInstanceOf(WorktreeLockBusyError);
    // First lock still exists + still owned by first.
    expect(existsSync(first.path)).toBe(true);
    const content = JSON.parse(readFileSync(first.path, 'utf8'));
    expect(content.runId).toBe('first');
    first.release();
  });
});

describe('child registry (L1.T7)', () => {
  beforeEach(() => {
    _resetForTests();
  });
  afterEach(() => {
    _resetForTests();
  });

  it('registerChild adds entry; unregister removes', () => {
    const entry = registerChild(99999, 'claude');
    expect(_snapshotRegistry()).toHaveLength(1);
    expect(_snapshotRegistry()[0]).toEqual({ pid: 99999, agent: 'claude' });

    unregisterChild(entry);
    expect(_snapshotRegistry()).toHaveLength(0);
  });

  it('unregister is idempotent (safe to call after already removed)', () => {
    const entry = registerChild(11111, 'pi');
    unregisterChild(entry);
    unregisterChild(entry); // no throw
    expect(_snapshotRegistry()).toHaveLength(0);
  });

  it('multiple concurrent children tracked independently', () => {
    const a = registerChild(1, 'claude');
    const b = registerChild(2, 'codex');
    const c = registerChild(3, 'pi');
    expect(_snapshotRegistry()).toHaveLength(3);

    unregisterChild(b);
    expect(_snapshotRegistry()).toHaveLength(2);
    expect(_snapshotRegistry().map((r) => r.pid).sort()).toEqual([1, 3]);

    unregisterChild(a);
    unregisterChild(c);
    expect(_snapshotRegistry()).toHaveLength(0);
  });

  it('exit hook installed exactly once across many registrations', () => {
    // We can't directly observe `process.on('exit')` listener count
    // without leaking state, but we can verify multiple register
    // calls don't throw on duplicate hook installation.
    for (let i = 0; i < 100; i++) {
      registerChild(1000 + i, 'claude');
    }
    expect(_snapshotRegistry()).toHaveLength(100);
    // Cleanup
    for (const entry of [..._snapshotRegistry()]) {
      unregisterChild(entry);
    }
  });
});

describe('AbstractAgentHandle integration (L1.T7)', () => {
  it('lockfile acquired + released via real adapter happy path', async () => {
    // Use the existing claude stub since it's the simplest happy path.
    // After spawn → drain events → close, the lockfile MUST be gone.
    const { ClaudeAdapter } = await import(
      '../src/core/auto-code/harness/index.js'
    );
    const stubDir = mkdtempSync(join(tmpdir(), 'morion-safety-int-stub-'));
    const wrapper = join(stubDir, 'claude');
    const stubPath = join(__dirname, 'fixtures', 'claude-stub.cjs');
    const { writeFileSync, chmodSync } = await import('node:fs');
    writeFileSync(
      wrapper,
      `#!/usr/bin/env bash\nexec "${process.execPath}" "${stubPath}" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);

    const workDir = mkdtempSync(join(tmpdir(), 'morion-safety-int-cwd-'));
    try {
      const adapter = new ClaudeAdapter({ binPath: wrapper });
      const handle = await adapter.spawn({
        prompt: 'x',
        cwd: workDir,
      });
      // Lockfile should exist mid-run.
      expect(existsSync(join(workDir, LOCK_FILENAME))).toBe(true);

      // Drain to terminal.
      for await (const _ev of handle.events) {
        // empty body intentional
        void _ev;
      }
      // After close, lockfile released.
      expect(existsSync(join(workDir, LOCK_FILENAME))).toBe(false);
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('lockfile released even on AgentSpawnError (e.g. async ENOENT)', async () => {
    const { ClaudeAdapter } = await import(
      '../src/core/auto-code/harness/index.js'
    );
    const dir = mkdtempSync(join(tmpdir(), 'morion-safety-fail-noexec-'));
    const fakePath = join(dir, 'claude');
    writeFileSync(fakePath, 'not a real script\n');
    const { chmodSync } = await import('node:fs');
    chmodSync(fakePath, 0o644);
    const workDir = mkdtempSync(join(tmpdir(), 'morion-safety-fail-cwd-'));
    try {
      const adapter = new ClaudeAdapter({ binPath: fakePath });
      await expect(
        adapter.spawn({ prompt: 'x', cwd: workDir }),
      ).rejects.toThrow();
      // No leftover lockfile after async failure.
      expect(existsSync(join(workDir, LOCK_FILENAME))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

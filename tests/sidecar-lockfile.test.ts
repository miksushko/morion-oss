import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapPriorAndLock, releaseLock } from '../src/server/bootstrap/sidecar-lockfile.js';

/**
 * Tests for the sidecar lockfile + reap-prior path
 * (ticket `01KQVA65TJ2VCY8VCKH9N5F6W8`, 2026-05-05).
 *
 * The lockfile lives at `<configDir>/morion-serve.pid`. On startup,
 * the new sidecar reads it, SIGTERMs the prior PID if alive, waits,
 * then writes its own PID. On clean shutdown, the file gets unlinked.
 *
 * Tests use injected `killProbe` + `sleepMs` so we don't actually
 * spawn child processes. The probe records every (pid, signal) pair
 * we'd send.
 */
describe('reapPriorAndLock', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'morion-lockfile-test-'));
  });

  afterEach(() => {
    try { rmSync(configDir, { recursive: true, force: true }); } catch {}
  });

  it('writes our PID to <configDir>/morion-serve.pid when no prior file exists', () => {
    const probe = vi.fn(() => false);
    reapPriorAndLock(configDir, {
      killProbe: probe,
      sleepMs: () => {},
      log: () => {},
    });

    const lockfile = join(configDir, 'morion-serve.pid');
    expect(existsSync(lockfile)).toBe(true);
    expect(readFileSync(lockfile, 'utf8')).toBe(String(process.pid));
    // Never tried to kill anyone — there was no prior.
    expect(probe).not.toHaveBeenCalled();
  });

  it('SIGTERMs a stale prior PID that is still alive, then writes our own', () => {
    const lockfile = join(configDir, 'morion-serve.pid');
    writeFileSync(lockfile, '99999\n', 'utf8');

    // Track kill calls so we can assert the sequence.
    const calls: Array<[number, string | number]> = [];
    let aliveCalls = 0;
    const probe = vi.fn((pid: number, signal: 0 | 'SIGTERM' | 'SIGKILL') => {
      calls.push([pid, signal]);
      if (pid !== 99999) return false;
      // First few "alive" probes return true, then it dies after SIGTERM.
      if (signal === 'SIGTERM') return true;
      if (signal === 0) {
        aliveCalls += 1;
        // First probe (pre-TERM): alive.
        // Second probe (post-TERM, first poll): alive — give it a tick.
        // Third probe (second poll): dead.
        return aliveCalls < 3;
      }
      return false;
    });

    reapPriorAndLock(configDir, {
      killProbe: probe,
      sleepMs: () => {},
      log: () => {},
    });

    // Probe sequence: probe(0) → SIGTERM → probe(0) loop until dead.
    expect(calls[0]).toEqual([99999, 0]); // initial alive check
    expect(calls[1]).toEqual([99999, 'SIGTERM']);
    expect(calls.some(([_, s]) => s === 'SIGKILL')).toBe(false); // didn't need fallback
    // Lockfile now points at us.
    expect(readFileSync(lockfile, 'utf8')).toBe(String(process.pid));
  });

  it('SIGKILLs after termWaitMs if prior ignores SIGTERM', () => {
    const lockfile = join(configDir, 'morion-serve.pid');
    writeFileSync(lockfile, '99999\n', 'utf8');

    const calls: Array<[number, string | number]> = [];
    const probe = vi.fn((pid: number, signal: 0 | 'SIGTERM' | 'SIGKILL') => {
      calls.push([pid, signal]);
      if (pid !== 99999) return false;
      // Stubborn process: stays "alive" until SIGKILL, then dies.
      if (signal === 'SIGKILL') return true; // SIGKILL succeeds
      if (signal === 'SIGTERM') return true;
      // probe(0): alive forever (stubborn process)
      return true;
    });

    reapPriorAndLock(configDir, {
      killProbe: probe,
      sleepMs: () => {}, // skip real waiting
      log: () => {},
      termWaitMs: 100, // short for the test
    });

    const sigkillSent = calls.some(
      ([pid, s]) => pid === 99999 && s === 'SIGKILL',
    );
    expect(sigkillSent).toBe(true);
    expect(readFileSync(lockfile, 'utf8')).toBe(String(process.pid));
  });

  it('overwrites stale lockfile when prior PID is already dead (no signals sent)', () => {
    const lockfile = join(configDir, 'morion-serve.pid');
    writeFileSync(lockfile, '99999\n', 'utf8');

    const probe = vi.fn(() => false); // every probe says "not alive"

    reapPriorAndLock(configDir, {
      killProbe: probe,
      sleepMs: () => {},
      log: () => {},
    });

    // We probed once (the initial alive check) and it returned false,
    // so we never sent SIGTERM or SIGKILL.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(99999, 0);
    expect(readFileSync(lockfile, 'utf8')).toBe(String(process.pid));
  });

  it('no-ops when the lockfile already points at our own PID', () => {
    const lockfile = join(configDir, 'morion-serve.pid');
    writeFileSync(lockfile, String(process.pid), 'utf8');

    const probe = vi.fn(() => true);

    reapPriorAndLock(configDir, {
      killProbe: probe,
      sleepMs: () => {},
      log: () => {},
    });

    // Same PID — no kill probes, just re-write our own PID
    // (idempotent).
    expect(probe).not.toHaveBeenCalled();
    expect(readFileSync(lockfile, 'utf8')).toBe(String(process.pid));
  });

  it('tolerates malformed prior pidfile (non-numeric content)', () => {
    const lockfile = join(configDir, 'morion-serve.pid');
    writeFileSync(lockfile, 'garbage\n', 'utf8');

    const probe = vi.fn(() => false);

    expect(() =>
      reapPriorAndLock(configDir, {
        killProbe: probe,
        sleepMs: () => {},
        log: () => {},
      }),
    ).not.toThrow();
    // Garbage couldn't be parsed → no kill probe attempted.
    expect(probe).not.toHaveBeenCalled();
    // We still wrote our own PID over the garbage.
    expect(readFileSync(lockfile, 'utf8')).toBe(String(process.pid));
  });
});

describe('releaseLock', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'morion-lockfile-release-'));
  });

  afterEach(() => {
    try { rmSync(configDir, { recursive: true, force: true }); } catch {}
  });

  it('removes the lockfile when it points at our own PID', () => {
    const lockfile = join(configDir, 'morion-serve.pid');
    writeFileSync(lockfile, String(process.pid), 'utf8');
    releaseLock(configDir);
    expect(existsSync(lockfile)).toBe(false);
  });

  it('leaves the lockfile alone when it points at a different PID (race-safe)', () => {
    const lockfile = join(configDir, 'morion-serve.pid');
    // A newer sidecar already replaced our PID with its own — we
    // shouldn't nuke its lock as we exit.
    writeFileSync(lockfile, '99999', 'utf8');
    releaseLock(configDir);
    expect(existsSync(lockfile)).toBe(true);
    expect(readFileSync(lockfile, 'utf8')).toBe('99999');
  });

  it('no-ops when the lockfile does not exist', () => {
    expect(() => releaseLock(configDir)).not.toThrow();
  });
});

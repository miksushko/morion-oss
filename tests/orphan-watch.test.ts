import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  watchParentViaPpid,
  watchParentViaStdioAndPpid,
} from '../src/server/bootstrap/orphan-watch.js';

/**
 * Tests for ticket `01KQVA65TJ2VCY8VCKH9N5F6W8` (2026-05-05) zombie
 * sidecar prevention. Real incident: a user accumulated 21 prod +
 * 9 dev zombies over 24 days that were burning ~2000 Gemini calls /
 * day on his OpenRouter key. The orphan-watch helpers added in this
 * pass detect parent death and trigger clean shutdown.
 *
 * Tests cover the two detection strategies (ppid polling + stdin
 * EOF) on isolated harness inputs — no real process spawning, no
 * real signal handling. Strategies tested:
 *
 *   1. ppid polling — fires on ppid==1 (re-parent to init) and on
 *      any ppid change from initial.
 *   2. stdin EOF — fires on the synthetic 'end' event.
 *   3. both layers fire onOrphan ONLY ONCE even when both signals
 *      arrive (de-dup via shared `fired` flag).
 *   4. Initial ppid==1 is NOT armed — that's a legitimate
 *      "started by launchd / systemd" case.
 */

describe('watchParentViaPpid', () => {
  it('fires onOrphan when ppid drops to 1 (kernel re-parented to init)', () => {
    let ppid = 12345;
    const onOrphan = vi.fn();
    const dispose = watchParentViaPpid({
      onOrphan,
      intervalMs: 5,
      initialPpid: ppid,
      getPpid: () => ppid,
      log: () => {},
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        ppid = 1;
        setTimeout(() => {
          expect(onOrphan).toHaveBeenCalledTimes(1);
          expect(onOrphan).toHaveBeenCalledWith('ppid_init');
          dispose();
          resolve();
        }, 30);
      }, 20);
    });
  });

  it('fires onOrphan when ppid changes (Windows / macOS edge case)', () => {
    let ppid = 12345;
    const onOrphan = vi.fn();
    const dispose = watchParentViaPpid({
      onOrphan,
      intervalMs: 5,
      initialPpid: ppid,
      getPpid: () => ppid,
      log: () => {},
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        ppid = 99999; // parent gone, OS re-attached us elsewhere
        setTimeout(() => {
          expect(onOrphan).toHaveBeenCalledTimes(1);
          expect(onOrphan).toHaveBeenCalledWith('ppid_changed');
          dispose();
          resolve();
        }, 30);
      }, 20);
    });
  });

  it('does not fire while ppid stays the same', () => {
    const onOrphan = vi.fn();
    const dispose = watchParentViaPpid({
      onOrphan,
      intervalMs: 5,
      initialPpid: 12345,
      getPpid: () => 12345,
      log: () => {},
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(onOrphan).not.toHaveBeenCalled();
        dispose();
        resolve();
      }, 30);
    });
  });

  it('skips arming when initialPpid is 1 (legitimate launchd/systemd start)', () => {
    const onOrphan = vi.fn();
    let getPpidCalls = 0;
    const dispose = watchParentViaPpid({
      onOrphan,
      intervalMs: 5,
      initialPpid: 1,
      getPpid: () => {
        getPpidCalls += 1;
        return 1;
      },
      log: () => {},
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Watch was never armed — getPpid only got called by the
        // initialPpid auto-resolver (which we override with the
        // explicit `initialPpid: 1`, so 0 calls).
        expect(getPpidCalls).toBe(0);
        expect(onOrphan).not.toHaveBeenCalled();
        dispose();
        resolve();
      }, 30);
    });
  });

  it('fires onOrphan exactly once even when ppid keeps drifting', () => {
    let ppid = 12345;
    const onOrphan = vi.fn();
    const dispose = watchParentViaPpid({
      onOrphan,
      intervalMs: 5,
      initialPpid: ppid,
      getPpid: () => ppid,
      log: () => {},
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        ppid = 99999;
        setTimeout(() => {
          ppid = 88888;
          setTimeout(() => {
            ppid = 1;
            setTimeout(() => {
              expect(onOrphan).toHaveBeenCalledTimes(1);
              dispose();
              resolve();
            }, 30);
          }, 15);
        }, 15);
      }, 15);
    });
  });

  it('survives a getPpid throw without crashing the timer', () => {
    let throwIt = false;
    let ppid = 12345;
    const onOrphan = vi.fn();
    const dispose = watchParentViaPpid({
      onOrphan,
      intervalMs: 5,
      initialPpid: ppid,
      getPpid: () => {
        if (throwIt) throw new Error('transient ppid read failure');
        return ppid;
      },
      log: () => {},
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        throwIt = true;
        setTimeout(() => {
          throwIt = false;
          ppid = 1;
          setTimeout(() => {
            expect(onOrphan).toHaveBeenCalledTimes(1);
            dispose();
            resolve();
          }, 30);
        }, 20);
      }, 20);
    });
  });
});

describe('watchParentViaStdioAndPpid', () => {
  it('fires onOrphan on stdin EOF (fast path)', () => {
    const stdin = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const onOrphan = vi.fn();
    const dispose = watchParentViaStdioAndPpid({
      onOrphan,
      intervalMs: 5_000, // ppid path effectively disabled for this test
      initialPpid: 12345,
      getPpid: () => 12345,
      stdin,
      log: () => {},
    });
    (stdin as EventEmitter).emit('end');
    expect(onOrphan).toHaveBeenCalledTimes(1);
    expect(onOrphan).toHaveBeenCalledWith('stdin_eof');
    dispose();
  });

  it('fires onOrphan on ppid signal when stdin stays open (defence in depth)', () => {
    const stdin = new EventEmitter() as unknown as NodeJS.ReadableStream;
    let ppid = 12345;
    const onOrphan = vi.fn();
    const dispose = watchParentViaStdioAndPpid({
      onOrphan,
      intervalMs: 5,
      initialPpid: ppid,
      getPpid: () => ppid,
      stdin,
      log: () => {},
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        ppid = 1;
        setTimeout(() => {
          expect(onOrphan).toHaveBeenCalledTimes(1);
          expect(onOrphan).toHaveBeenCalledWith('ppid_init');
          dispose();
          resolve();
        }, 30);
      }, 20);
    });
  });

  it('does NOT double-fire when both signals arrive', () => {
    const stdin = new EventEmitter() as unknown as NodeJS.ReadableStream;
    let ppid = 12345;
    const onOrphan = vi.fn();
    const dispose = watchParentViaStdioAndPpid({
      onOrphan,
      intervalMs: 5,
      initialPpid: ppid,
      getPpid: () => ppid,
      stdin,
      log: () => {},
    });
    return new Promise<void>((resolve) => {
      // Fire stdin EOF first.
      (stdin as EventEmitter).emit('end');
      // Then trigger ppid signal too.
      setTimeout(() => {
        ppid = 1;
        setTimeout(() => {
          // onOrphan must have fired exactly once.
          expect(onOrphan).toHaveBeenCalledTimes(1);
          expect(onOrphan).toHaveBeenCalledWith('stdin_eof');
          dispose();
          resolve();
        }, 30);
      }, 10);
    });
  });
});

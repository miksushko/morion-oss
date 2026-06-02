/**
 * Regression: Mo tag-delete UI divergence (umbrella ticket
 * 01KQ1R97C0GK6KPQF03AFCZ42B → fix ticket 01KQ21WMG3Q9S3YDK57C4G3AJ8).
 *
 * The hook used to act on FUTURE `db.changed` frames only. When the
 * WS was down during a burst of MCP/Mo writes (or when `fs.watch` on
 * the WAL coalesced frames under load), the UI would silently miss
 * dropped notifications until the next user write.
 *
 * Fix: `ws.onopen` ALSO refetches every collection once on every
 * (re)connect. Tested via the pure `connectLiveSync` helper extracted
 * from the hook so we don't need React/jsdom in this test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { connectLiveSync } from '../src/web/src/hooks/useLiveSync';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static last(): FakeWebSocket {
    const i = this.instances[this.instances.length - 1];
    if (!i) throw new Error('no FakeWebSocket constructed yet');
    return i;
  }
  url: string;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

function buildRefresh() {
  return {
    refreshNotes: vi.fn(async () => {}),
    refreshFolders: vi.fn(async () => {}),
    refreshTags: vi.fn(async () => {}),
    refreshTrash: vi.fn(async () => {}),
    onTick: vi.fn(),
  };
}

interface ScheduledTimer {
  cb: () => void;
  delay: number;
}

function buildFakeTimers() {
  const scheduled: ScheduledTimer[] = [];
  const setTimeoutFn = ((cb: () => void, delay: number) => {
    scheduled.push({ cb, delay });
    return scheduled.length as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = ((id: ReturnType<typeof setTimeout>) => {
    const idx = (id as unknown as number) - 1;
    if (idx >= 0 && idx < scheduled.length) {
      scheduled[idx] = { cb: () => {}, delay: 0 };
    }
  }) as unknown as typeof clearTimeout;
  return {
    setTimeoutFn,
    clearTimeoutFn,
    /** Run every pending timer once, in scheduling order. */
    flush() {
      const queued = scheduled.splice(0, scheduled.length);
      for (const t of queued) t.cb();
    },
    pending: () => scheduled.length,
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

describe('connectLiveSync — refetch on RECONNECT only (01KQ21WMG3Q9S3YDK57C4G3AJ8 + runaway-loop fix 2026-04-25)', () => {
  it('does NOT trigger refresh* on the very first WebSocket open', () => {
    // App.tsx already fetched everything by the time the hook mounts.
    // Refetching on first open is wasted work AND the entry point of
    // the runaway loop when the hook's deps churn (each effect re-run
    // is a new connectLiveSync invocation; refetching from each one's
    // first onopen produces a setState→render→effect→connect→onopen
    // feedback loop). Refetch only on RECONNECT.
    const refresh = buildRefresh();
    const timers = buildFakeTimers();
    const disconnect = connectLiveSync({
      url: 'ws://test.local/api/events',
      protocols: [],
      refresh,
      wsCtor: (u) => new FakeWebSocket(u) as unknown as WebSocket,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    FakeWebSocket.last().onopen?.();

    expect(refresh.refreshNotes).not.toHaveBeenCalled();
    expect(refresh.refreshFolders).not.toHaveBeenCalled();
    expect(refresh.refreshTags).not.toHaveBeenCalled();
    expect(refresh.refreshTrash).not.toHaveBeenCalled();
    expect(refresh.onTick).not.toHaveBeenCalled();
    disconnect();
  });

  it('DOES trigger refresh* on reconnect (sidecar restart, sleep/wake)', () => {
    const refresh = buildRefresh();
    const timers = buildFakeTimers();
    const disconnect = connectLiveSync({
      url: 'ws://test.local/api/events',
      protocols: [],
      refresh,
      wsCtor: (u) => new FakeWebSocket(u) as unknown as WebSocket,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    // First connect — no refetch (per the test above).
    const first = FakeWebSocket.last();
    first.onopen?.();
    expect(refresh.refreshNotes).not.toHaveBeenCalled();

    // Drop + reconnect.
    first.onclose?.();
    expect(timers.pending()).toBe(1);
    timers.flush();

    const second = FakeWebSocket.last();
    expect(second).not.toBe(first);
    second.onopen?.();

    // Refetchers fire ONCE — only the reconnect onopen, not the first.
    expect(refresh.refreshNotes).toHaveBeenCalledTimes(1);
    expect(refresh.refreshFolders).toHaveBeenCalledTimes(1);
    expect(refresh.refreshTags).toHaveBeenCalledTimes(1);
    expect(refresh.refreshTrash).toHaveBeenCalledTimes(1);
    expect(refresh.onTick).toHaveBeenCalledTimes(1);
    disconnect();
  });

  it('still handles `db.changed` messages by calling refresh*', () => {
    const refresh = buildRefresh();
    const timers = buildFakeTimers();
    const disconnect = connectLiveSync({
      url: 'ws://test.local/api/events',
      protocols: [],
      refresh,
      wsCtor: (u) => new FakeWebSocket(u) as unknown as WebSocket,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    FakeWebSocket.last().onmessage?.({
      data: JSON.stringify({ type: 'db.changed' }),
    });

    expect(refresh.refreshNotes).toHaveBeenCalledTimes(1);
    expect(refresh.refreshFolders).toHaveBeenCalledTimes(1);
    expect(refresh.refreshTags).toHaveBeenCalledTimes(1);
    expect(refresh.refreshTrash).toHaveBeenCalledTimes(1);
    expect(refresh.onTick).toHaveBeenCalledTimes(1);
    disconnect();
  });

  it('disconnect() cancels reconnect timers', () => {
    const refresh = buildRefresh();
    const timers = buildFakeTimers();
    const disconnect = connectLiveSync({
      url: 'ws://test.local/api/events',
      protocols: [],
      refresh,
      wsCtor: (u) => new FakeWebSocket(u) as unknown as WebSocket,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    FakeWebSocket.last().onclose?.();
    expect(timers.pending()).toBe(1);
    disconnect();
    timers.flush(); // any leftover should be a no-op cleared cb
    // No new WebSocket should have been constructed by the cleared timer.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

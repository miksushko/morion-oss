import { describe, it, expect, beforeEach } from 'vitest';
import {
  ChatProgressBus,
  type ChatProgressEnvelope,
} from '../src/core/concierge/index.js';

function envelope(
  toolCallId: string,
  ts: number,
  eventKind: 'wave_start' | 'wave_complete' | 'synthesis_complete',
): ChatProgressEnvelope {
  if (eventKind === 'wave_start') {
    return {
      toolCallId,
      toolName: 'mo_get_context',
      ts,
      event: { kind: 'wave_start', wave: 1, subMoCount: 5 },
    };
  }
  if (eventKind === 'wave_complete') {
    return {
      toolCallId,
      toolName: 'mo_get_context',
      ts,
      event: {
        kind: 'wave_complete',
        wave: 1,
        okCount: 4,
        failedCount: 1,
        spentUsd: 0.005,
      },
    };
  }
  return {
    toolCallId,
    toolName: 'mo_get_context',
    ts,
    event: { kind: 'synthesis_complete', spentUsd: 0.01 },
  };
}

describe('ChatProgressBus', () => {
  let bus: ChatProgressBus;
  beforeEach(() => {
    bus = new ChatProgressBus();
  });

  it('publishes events to live subscribers', () => {
    const received: ChatProgressEnvelope[] = [];
    const sub = bus.subscribe('sess-1', (env) => received.push(env));
    expect(sub.replay).toEqual([]);

    bus.publish('sess-1', envelope('tc-A', 1000, 'wave_start'));
    bus.publish('sess-1', envelope('tc-A', 1500, 'wave_complete'));

    expect(received).toHaveLength(2);
    expect(received[0]?.event.kind).toBe('wave_start');
    expect(received[1]?.event.kind).toBe('wave_complete');

    sub.unsubscribe();
  });

  it('replays buffered events to a late subscriber (no listener miss)', () => {
    bus.publish('sess-2', envelope('tc-B', 1000, 'wave_start'));
    bus.publish('sess-2', envelope('tc-B', 1500, 'wave_complete'));

    const received: ChatProgressEnvelope[] = [];
    const sub = bus.subscribe('sess-2', (env) => received.push(env));
    expect(sub.replay).toHaveLength(2);
    expect(sub.replay[0]?.event.kind).toBe('wave_start');
    expect(sub.replay[1]?.event.kind).toBe('wave_complete');
    expect(received).toEqual([]);

    bus.publish('sess-2', envelope('tc-B', 2000, 'synthesis_complete'));
    expect(received).toHaveLength(1);
    expect(received[0]?.event.kind).toBe('synthesis_complete');

    sub.unsubscribe();
  });

  it('isolates events by sessionId — sub-A does not see sub-B publishes', () => {
    const seenA: ChatProgressEnvelope[] = [];
    const seenB: ChatProgressEnvelope[] = [];
    bus.subscribe('sess-A', (env) => seenA.push(env));
    bus.subscribe('sess-B', (env) => seenB.push(env));

    bus.publish('sess-A', envelope('tc-x', 1000, 'wave_start'));
    bus.publish('sess-B', envelope('tc-y', 1000, 'wave_complete'));

    expect(seenA).toHaveLength(1);
    expect(seenA[0]?.toolCallId).toBe('tc-x');
    expect(seenB).toHaveLength(1);
    expect(seenB[0]?.toolCallId).toBe('tc-y');
  });

  it('unsubscribe stops further events to that listener', () => {
    const received: ChatProgressEnvelope[] = [];
    const sub = bus.subscribe('sess-3', (env) => received.push(env));

    bus.publish('sess-3', envelope('tc-1', 1000, 'wave_start'));
    sub.unsubscribe();
    bus.publish('sess-3', envelope('tc-1', 2000, 'wave_complete'));

    expect(received).toHaveLength(1);
  });

  it('caps the per-session buffer (drops oldest beyond cap)', () => {
    // Publish 60 events; cap is 50; expect to retain the latest 50.
    for (let i = 0; i < 60; i++) {
      bus.publish('sess-cap', envelope(`tc-${i}`, 1000 + i, 'wave_start'));
    }
    const sub = bus.subscribe('sess-cap', () => {});
    expect(sub.replay.length).toBeLessThanOrEqual(50);
    // The newest event MUST be in the buffer.
    const lastReplayed = sub.replay[sub.replay.length - 1];
    expect(lastReplayed?.toolCallId).toBe('tc-59');
  });

  it('clear(sessionId) drops the buffer + active listeners', () => {
    const received: ChatProgressEnvelope[] = [];
    bus.subscribe('sess-clr', (env) => received.push(env));
    bus.publish('sess-clr', envelope('tc-1', 1000, 'wave_start'));
    expect(received).toHaveLength(1);

    bus.clear('sess-clr');

    // Publish to the cleared session — listener should be gone.
    bus.publish('sess-clr', envelope('tc-2', 2000, 'wave_complete'));
    expect(received).toHaveLength(1);

    // New subscriber sees an empty replay.
    const sub2 = bus.subscribe('sess-clr', () => {});
    // The publish above re-created the channel with one buffered event.
    // That's expected — clear() is for end-of-dispatch cleanup; if a
    // late publish arrives after clear, it starts a fresh buffer.
    expect(sub2.replay).toHaveLength(1);
  });

  it('one broken listener does not block other listeners', () => {
    const goodReceived: ChatProgressEnvelope[] = [];
    bus.subscribe('sess-good', () => {
      throw new Error('listener exploded');
    });
    bus.subscribe('sess-good', (env) => goodReceived.push(env));

    bus.publish('sess-good', envelope('tc-1', 1000, 'wave_start'));
    expect(goodReceived).toHaveLength(1);
  });

  it('evictIdle drops channels with no listeners + no recent activity', () => {
    // Publish-only setup: no subscribe (subscribe would touch
    // lastActivityAt to real-now and bypass our deterministic ts).
    // The channel ends up with listeners.size === 0 because nobody
    // ever subscribed.
    bus.publish('sess-old', envelope('tc-1', 1000, 'wave_start'));
    expect(bus.size()).toBe(1);

    // Force eviction with a "now" 11 minutes after the publish (idle TTL is 10 min).
    bus.evictIdle(1000 + 11 * 60 * 1000);
    expect(bus.size()).toBe(0);
  });

  it('does NOT evict channels with active listeners even if old', () => {
    const sub = bus.subscribe('sess-live', () => {});
    bus.publish('sess-live', envelope('tc-1', 1000, 'wave_start'));

    bus.evictIdle(1000 + 11 * 60 * 1000);
    expect(bus.size()).toBe(1); // listener still attached
    sub.unsubscribe();
  });
});

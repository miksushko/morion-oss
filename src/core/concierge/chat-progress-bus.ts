import type { GatherProgressEvent } from './context/types.js';

/**
 * Per-session progress event bus for long-running mo_* tool calls
 * dispatched from the Ask Mo chat. Decouples the synchronous chat
 * dispatch loop (which runs inside one HTTP POST) from the SSE
 * subscriber (which is a separate GET that the UI keeps open while
 * waiting for the POST to finish).
 *
 * Real-world incident 2026-05-04: chat-tier Mo dispatched
 * `mo_get_context`, gather took >60 seconds, the chat UI showed only
 * a static "Mo is thinking" indicator the entire time → user thought
 * it hung. The gather engine already emits Wave-by-Wave progress
 * events via `onProgress` callback; this bus is the conduit that
 * gets them from inside the dispatch loop out to the SSE stream the
 * UI subscribes to.
 *
 * Shape:
 *   - sessionId-keyed channel with bounded buffered history (so a
 *     UI subscriber that opens the SSE AFTER posting the message
 *     still sees the events that already fired).
 *   - In-memory only — no persistence. Progress events are
 *     ephemeral; if the user reloads mid-gather they get a fresh
 *     "Mo is thinking" until the dispatch finishes.
 *   - Idle TTL eviction (default 10 min) so abandoned sessions don't
 *     accumulate.
 *
 * NOT a general event emitter — keep this module narrow. If a third
 * tool needs progress streaming, extend the event shape; don't
 * generalise to "subscribe to anything in any session".
 */

export interface ChatProgressEnvelope {
  /** Unique id of the LLM tool call this event belongs to. Lets the
   *  UI route the event to the right inflight bubble when multiple
   *  tools dispatch in parallel (rare but possible). */
  toolCallId: string;
  /** MCP tool name (always `mo_get_context` today; future tools can
   *  reuse the bus). UI uses this to pick the right human label. */
  toolName: string;
  /** Wall-clock ms when the event fired — UI shows elapsed time. */
  ts: number;
  /** The structured gather progress event verbatim. UI translates to
   *  display strings ("Wave 1: 4/10 sub-Mos done"); the bus stays
   *  wire-format-only. */
  event: GatherProgressEvent;
}

interface SessionChannel {
  /** Bounded buffer of past events. Late SSE subscribers get the
   *  buffer first, then live events. */
  buffered: ChatProgressEnvelope[];
  /** Live listeners (every open SSE for this session). */
  listeners: Set<(env: ChatProgressEnvelope) => void>;
  /** Last activity ts — used for idle eviction. */
  lastActivityAt: number;
}

/** Cap per-session buffer. ~20 events covers a worst-case 3-wave
 *  gather (bootstrap + 3×wave_start/complete + synthesis_start/
 *  complete + a few caps). 50 is generous headroom. */
const BUFFER_CAP = 50;

/** Idle eviction window. Sessions with no activity for this long
 *  get their channel dropped from memory on the next publish. Keeps
 *  long-running processes from accumulating dead session entries. */
const IDLE_TTL_MS = 10 * 60 * 1000;

export class ChatProgressBus {
  private readonly channels = new Map<string, SessionChannel>();

  /**
   * Publish a progress event to all live listeners + the buffer.
   * Triggers idle-channel eviction on every call (cheap — just walks
   * `channels` once). Caller is the chat dispatch loop.
   */
  publish(sessionId: string, env: ChatProgressEnvelope): void {
    const now = env.ts;
    this.evictIdle(now);

    let channel = this.channels.get(sessionId);
    if (!channel) {
      channel = { buffered: [], listeners: new Set(), lastActivityAt: now };
      this.channels.set(sessionId, channel);
    }
    channel.lastActivityAt = now;
    channel.buffered.push(env);
    if (channel.buffered.length > BUFFER_CAP) {
      // Drop oldest. UI cares about latest progress, not full history.
      channel.buffered.splice(0, channel.buffered.length - BUFFER_CAP);
    }
    for (const listener of channel.listeners) {
      try {
        listener(env);
      } catch {
        // Don't let one broken listener block the others.
      }
    }
  }

  /**
   * Subscribe to live events for a session. Returns:
   *   - A snapshot of buffered events (replay for late subscribers)
   *   - An unsubscribe function (caller MUST call on SSE disconnect)
   *
   * The replay snapshot is a copy, so caller iteration can't be
   * mutated by concurrent publishes. After the snapshot is read,
   * the listener fires for every subsequent event.
   */
  subscribe(
    sessionId: string,
    listener: (env: ChatProgressEnvelope) => void,
  ): { replay: ChatProgressEnvelope[]; unsubscribe: () => void } {
    const now = Date.now();
    let channel = this.channels.get(sessionId);
    if (!channel) {
      channel = { buffered: [], listeners: new Set(), lastActivityAt: now };
      this.channels.set(sessionId, channel);
    }
    channel.lastActivityAt = now;
    channel.listeners.add(listener);
    return {
      replay: channel.buffered.slice(),
      unsubscribe: () => {
        const ch = this.channels.get(sessionId);
        if (!ch) return;
        ch.listeners.delete(listener);
        // Don't drop the channel here even if listeners is empty —
        // a buffered event might still be useful to a re-subscribing
        // client. Eviction handles real cleanup.
      },
    };
  }

  /**
   * Drop a session's buffer + listeners. Called when the chat
   * dispatch loop completes (terminal event for this session) so the
   * next user message starts with a clean slate.
   */
  clear(sessionId: string): void {
    this.channels.delete(sessionId);
  }

  /**
   * Walk channels and drop any whose `lastActivityAt` is older than
   * the idle TTL. Triggered on every `publish` for amortised
   * cleanup; can also be called externally if a long-lived process
   * needs deterministic cleanup ticks.
   */
  evictIdle(now: number = Date.now()): void {
    const cutoff = now - IDLE_TTL_MS;
    for (const [sessionId, channel] of this.channels) {
      if (channel.lastActivityAt < cutoff && channel.listeners.size === 0) {
        this.channels.delete(sessionId);
      }
    }
  }

  /** Diagnostics — number of active channels. */
  size(): number {
    return this.channels.size;
  }
}

/**
 * Process-wide singleton. The chat dispatch loop and the SSE
 * endpoint both need to reach the same bus instance; passing it
 * through the entire ToolContext chain would noise up every test
 * fixture. Same shape as the import-progress registry pattern.
 */
export const chatProgressBus = new ChatProgressBus();

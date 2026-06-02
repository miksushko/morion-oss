/**
 * EventBroadcast — internal helper for adapter event streams.
 *
 * Adapters call `emit(ev)` as events arrive from the underlying CLI.
 * Consumers iterate via `iterate()` returning an async iterator that
 * yields all buffered events from event 0, then awaits new ones until
 * the stream is `close()`d.
 *
 * Multi-consumer: each call to `iterate()` returns an independent
 * iterator that starts from event 0 with its own cursor. Late
 * consumers see the full history without missing prelude events.
 *
 * Memory: O(events) per run. Bounded since events per run are
 * bounded (typically <100 even for long runs). The transcript writer
 * (L1.T8) persists events to disk in parallel; nothing is dropped.
 *
 * Module is internal to the harness — not exported from `index.ts`.
 */

import type { CliAgentEvent } from './events.js';

export class EventBroadcast {
  private readonly _events: CliAgentEvent[] = [];
  private _closed = false;
  private readonly _waiters = new Set<() => void>();

  /** Push an event to all current + future consumers. No-op after
   *  `close()`. */
  emit(ev: CliAgentEvent): void {
    if (this._closed) return;
    this._events.push(ev);
    this._wake();
  }

  /** Close the stream. Pending iterators terminate cleanly with
   *  `{done: true}` after draining their queue. Idempotent. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._wake();
  }

  /** True after `close()`. */
  get isClosed(): boolean {
    return this._closed;
  }

  /** Snapshot of all events emitted so far. Useful for diagnostics
   *  + tests (the transcript file is the canonical persistent
   *  record — see L1.T8). */
  snapshot(): readonly CliAgentEvent[] {
    return this._events;
  }

  /** Returns an async iterator that yields every event from the
   *  beginning, then awaits new events, then terminates after
   *  `close()`. The iterator is `AsyncIterableIterator` so it can
   *  be consumed with `for await` directly OR via the
   *  `[Symbol.asyncIterator]` re-binding. */
  iterate(): AsyncIterableIterator<CliAgentEvent> {
    let cursor = 0;
    const self = this;
    const iterator: AsyncIterableIterator<CliAgentEvent> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      async next(): Promise<IteratorResult<CliAgentEvent>> {
        // Drain available events first.
        if (cursor < self._events.length) {
          const value = self._events[cursor]!;
          cursor++;
          return { value, done: false };
        }
        // No new events. If closed, terminate.
        if (self._closed) {
          return { value: undefined as never, done: true };
        }
        // Await next wake (emit OR close).
        await new Promise<void>((resolve) => {
          self._waiters.add(resolve);
        });
        return iterator.next();
      },
      async return(): Promise<IteratorResult<CliAgentEvent>> {
        return { value: undefined as never, done: true };
      },
    };
    return iterator;
  }

  private _wake(): void {
    const waiters = [...this._waiters];
    this._waiters.clear();
    for (const w of waiters) w();
  }
}

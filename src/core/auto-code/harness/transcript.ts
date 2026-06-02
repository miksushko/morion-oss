/**
 * Auto-code CLI Agent Harness — transcript file persistence (L1.T8).
 *
 * Every `AgentHandle` writes a per-run transcript JSONL file at
 * `<transcriptDir>/<runId>.jsonl` parallel to event broadcast emission.
 * Each event becomes one JSON line. Append-only. File handle stays
 * open for the lifetime of the handle, closes on terminal event /
 * process reap.
 *
 * Used downstream by:
 *   - **L2 UI drawer** — reads transcript file to render the
 *     full event timeline of past runs (live runs render via the
 *     async event broadcast).
 *   - **L3 retention pruning** — old transcript files (>14d for
 *     operational data) are deleted along with `workflow_audit`
 *     row pruning.
 *
 * Module is internal-ish — exposed via `harness/index.ts` only as
 * `TranscriptWriter` + `readTranscript` + `transcriptPathFor`. The
 * `AbstractAgentHandle` uses it transparently when caller passes
 * `transcriptDir` in `AbstractHandleParams`.
 */

import {
  createReadStream,
  type WriteStream,
  createWriteStream,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import type { CliAgentEvent } from './events.js';
import { parseEventLine } from './events-parse.js';

/** Resolve the canonical transcript file path for a given runId. */
export function transcriptPathFor(
  transcriptDir: string,
  runId: string,
): string {
  return join(transcriptDir, `${runId}.jsonl`);
}

/**
 * Append-only JSONL writer for a single agent run.
 *
 * Lifecycle:
 *   1. `await writer.open()` — creates parent dir + opens fd in append mode
 *   2. `writer.write(ev)` — queues a line write (non-blocking; serialised
 *      internally so concurrent emits don't interleave bytes)
 *   3. `await writer.close()` — drains the queue + closes fd
 *
 * Crash semantics: if the process dies mid-write, the file may be
 * truncated mid-line. Readers tolerate this — `readTranscript` skips
 * lines that fail to parse.
 */
export class TranscriptWriter {
  private _stream: WriteStream | null = null;
  /** Serialised write queue. Each `write()` call appends a then() to
   *  guarantee bytes don't interleave even when caller emits events
   *  faster than the OS flushes. */
  private _queue: Promise<void> = Promise.resolve();

  constructor(public readonly path: string) {}

  async open(): Promise<void> {
    if (this._stream) return; // idempotent
    await mkdir(dirname(this.path), { recursive: true });
    this._stream = createWriteStream(this.path, { flags: 'a' });
    // Capture stream errors to a no-op handler so they don't crash
    // the process. Real failures surface on close().
    this._stream.on('error', () => {
      /* swallowed — write() rejects on the stream's error event chain */
    });
  }

  /** Write one event as a JSON line. Non-blocking; returns void.
   *  Errors are swallowed (transcript is best-effort persistence;
   *  agent run is more important than the log). */
  write(ev: CliAgentEvent): void {
    if (!this._stream) return;
    const line = JSON.stringify(ev) + '\n';
    const stream = this._stream;
    this._queue = this._queue.then(
      () =>
        new Promise<void>((resolve) => {
          // Stream.write returns false when the internal buffer is
          // full — in that case wait for 'drain'. For our event sizes
          // (<10kB typical) the buffer rarely fills, but handle it
          // correctly to avoid lost events on bursts.
          const ok = stream.write(line);
          if (ok) {
            resolve();
          } else {
            stream.once('drain', () => resolve());
          }
        }),
    );
    // Detach the catch so unhandled rejections aren't propagated;
    // close() awaits the same chain and surfaces failures there.
    this._queue.catch(() => {
      /* swallowed */
    });
  }

  async close(): Promise<void> {
    if (!this._stream) return;
    // Drain queued writes before closing.
    try {
      await this._queue;
    } catch {
      // best-effort — close anyway
    }
    const stream = this._stream;
    this._stream = null;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }
}

/**
 * Read a transcript file as an async iterable of `CliAgentEvent`s.
 *
 * Lenient: lines that fail to parse (truncated tail from crashed
 * write, manual edit, version-mismatch) are silently skipped. The
 * iterable closes cleanly at EOF.
 *
 * Caller is responsible for the file existing — readers should
 * `existsSync(path)` first if uncertain. We let `createReadStream`
 * throw ENOENT through naturally otherwise.
 */
export async function* readTranscript(
  path: string,
): AsyncIterable<CliAgentEvent> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const ev = parseEventLine(line);
    if (ev) yield ev;
  }
}

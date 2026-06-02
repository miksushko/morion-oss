/**
 * Auto-code CLI Agent Harness — `AbstractAgentHandle` base class.
 *
 * Shared process-lifecycle plumbing for every adapter handle:
 *   - spawn + handshake (await `'spawn'` vs `'error'` race so async
 *     spawn failures reject the spawn() promise per contract)
 *   - SIGTERM → SIGKILL chain via the `_processReaped` flag
 *     (`child.killed` flips on the kill *call*, not actual exit, so
 *     it cannot drive the escalation timer — see lessons.md)
 *   - wall-clock timeout → cancel('timeout', 'timeout')
 *   - external AbortSignal → cancel('external_signal')
 *   - bounded stderr tail
 *   - terminal-event broadcast + close promise
 *
 * Subclass responsibilities (the only adapter-specific bits):
 *   - `_buildArgs()` — produce the CLI argv for this run
 *   - `_handleNormalClose(stdout, code)` — emit ONE terminal event
 *     (result / error) based on the agent's native output format.
 *     Cancel + external-kill paths are routed by the base class.
 *   - Optional override of `resume(injectedMessage?)` — default
 *     throws `AgentResumeUnsupportedError`. Subclasses whose CLI
 *     supports `--resume` override to construct a new handle.
 *
 * Internal to the harness; not exported from `index.ts`.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import {
  AgentResumeUnsupportedError,
  AgentSpawnError,
  type AgentHandle,
} from './adapter.js';
import { EventBroadcast } from './event-broadcast.js';
import type { AgentName, CliAgentEvent } from './events.js';
import {
  acquireWorktreeLock,
  registerChild,
  unregisterChild,
  type WorktreeLock,
} from './safety.js';
import { TranscriptWriter, transcriptPathFor } from './transcript.js';
import {
  SIGTERM_GRACE_MS,
  STDERR_TAIL_BYTES,
  type AbstractHandleParams,
} from './abstract-handle-types.js';

export abstract class AbstractAgentHandle implements AgentHandle {
  readonly sessionId: string;
  pid: number | null = null;

  protected readonly _params: AbstractHandleParams;
  protected readonly _broadcast = new EventBroadcast();
  protected _child: ChildProcess | null = null;
  protected _cost = 0;
  protected _cancelled = false;
  /** Per-worktree lockfile owned by this handle (acquired in
   *  `_spawnChild`, released in `'close'` handler). Prevents
   *  concurrent harness runs on the same worktree from corrupting
   *  each other's git state. */
  private _worktreeLock: WorktreeLock | null = null;
  /** Spawn-registry entry for parent-exit SIGKILL fallback. */
  private _registryEntry: ReturnType<typeof registerChild> | null = null;
  /** Transcript writer (when transcriptDir was set in params).
   *  Receives every event in parallel with broadcast. */
  private _transcript: TranscriptWriter | null = null;
  /** Stream-level: the terminal `result`/`error` event has been
   *  emitted to consumers. The event broadcast is closed; iterators
   *  see `{done: true}` next.
   *
   *  IMPORTANT: this flag does NOT mean the child process has
   *  exited. Streaming adapters (pi, opencode) may emit the
   *  terminal event from `_onStdoutChunk` (e.g. on pi's
   *  `agent_end`) while the child still runs — see §10 invariant
   *  in design doc. Cancel/timeout MUST still operate after this
   *  flag is set if `_processReaped` is false.
   *
   *  (Renamed from `_closed` in T5 follow-up Codex review.) */
  protected _terminalEventEmitted = false;
  /** Process-level: the child's `'close'` event has fired and the
   *  process is fully reaped. Drives the SIGKILL escalation timer
   *  + the `_closePromise` resolution. */
  protected _processReaped = false;
  protected _stderrTail = '';
  protected _cancelErrorKind: 'killed' | 'timeout' = 'killed';
  /** Resolves only when the process has been REAPED (not when the
   *  terminal event was emitted). Caller's `cancel()` / `await
   *  collectEvents` await this so they're guaranteed the child is
   *  truly dead before continuing. */
  protected readonly _closePromise: Promise<void>;
  protected _resolveClose: (() => void) | null = null;
  protected _signalListener: (() => void) | null = null;

  protected constructor(params: AbstractHandleParams) {
    this._params = params;
    this.sessionId = params.sessionId;
    this._closePromise = new Promise<void>((resolve) => {
      this._resolveClose = resolve;
    });
  }

  // -------------------------------------------------------------------
  // Subclass hooks
  // -------------------------------------------------------------------

  /** Subclass: produce the CLI argv. Called once at spawn time
   *  (inside `_spawnChild`). */
  protected abstract _buildArgs(): string[];

  /** Subclass: handle the child's clean close. Called with the full
   *  buffered stdout, the exit code, after the base class has
   *  filtered out cancel + external-kill paths.
   *
   *  Subclass MUST emit exactly one terminal event via
   *  `_emitTerminal(ev)` UNLESS one was already emitted mid-stream
   *  via `_onStdoutChunk`. Calling `_emitTerminal` after stream-time
   *  termination is a no-op (idempotent), so streaming adapters can
   *  use `_handleNormalClose` as a fallback for "stream ended
   *  without producing a terminal event". */
  protected abstract _handleNormalClose(
    stdout: string,
    code: number | null,
  ): void;

  /** Optional subclass hook: called for each chunk of stdout as it
   *  arrives. Default is no-op; the base class buffers stdout
   *  internally and delivers the full string to `_handleNormalClose`
   *  at child close.
   *
   *  Streaming adapters (pi `--mode json`, opencode `--format json`)
   *  override this to parse line-by-line and emit `CliAgentEvent`s
   *  incrementally. They typically maintain a line buffer for
   *  partial-chunk handling and may emit the terminal event mid-
   *  stream (e.g. on pi's `agent_end`). */
  protected _onStdoutChunk(_chunk: string): void {
    // default no-op
  }

  // -------------------------------------------------------------------
  // Public AgentHandle surface
  // -------------------------------------------------------------------

  get adapter(): AgentName {
    return this._params.agent;
  }

  get events(): AsyncIterable<CliAgentEvent> {
    return {
      [Symbol.asyncIterator]: () => this._broadcast.iterate(),
    };
  }

  /** Resolves when the child process is fully reaped. See AgentHandle
   *  JSDoc — streaming adapters may emit terminal events before the
   *  process exits, so callers requiring full cleanup (resume, lock
   *  release, retention) await this. */
  get exited(): Promise<void> {
    return this._closePromise;
  }

  async cancel(reason: string = 'parent_handle_cancel'): Promise<void> {
    return this._terminateProcess(reason, 'killed');
  }

  /** Default: throw `AgentResumeUnsupportedError`. Subclasses whose
   *  underlying CLI supports `--resume` override to construct a
   *  fresh handle with the resume args + injected message. */
  async resume(_injectedMessage?: string): Promise<AgentHandle> {
    throw new AgentResumeUnsupportedError(this._params.agent);
  }

  getCost(): number {
    return this._cost;
  }

  // -------------------------------------------------------------------
  // Internal lifecycle
  // -------------------------------------------------------------------

  /** Subclass static factory must call this immediately after `new`
   *  to actually spawn the child. */
  protected async _spawnChild(): Promise<void> {
    const args = this._buildArgs();
    const env = this._buildEnv();

    // Acquire per-worktree lock BEFORE spawn (L1.T7). Reaps any
    // stale prior harness PID in this cwd. Throws on filesystem
    // issue — caller surfaces as AgentSpawnError.
    try {
      this._worktreeLock = acquireWorktreeLock(this._params.cwd, {
        runId: this.sessionId,
      });
    } catch (e) {
      throw new AgentSpawnError(
        `${this._params.agent} could not acquire worktree lock: ${(e as Error).message}`,
        e,
      );
    }

    // Open transcript file BEFORE spawn (L1.T8) — every event from
    // session_start onward is captured to disk parallel to broadcast.
    if (this._params.transcriptDir) {
      try {
        this._transcript = new TranscriptWriter(
          transcriptPathFor(this._params.transcriptDir, this.sessionId),
        );
        await this._transcript.open();
      } catch (e) {
        // Best-effort: transcript persistence is not load-bearing
        // for the run itself. Log via stderr-style message in
        // _emitTerminal warning, but don't fail the spawn.
        this._transcript = null;
      }
    }

    let child: ChildProcess;
    try {
      child = spawn(this._params.binPath, args, {
        cwd: this._params.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      // Synchronous spawn failure (rare). Release lock so we don't
      // leave a stale entry blocking the next attempt.
      this._worktreeLock?.release();
      this._worktreeLock = null;
      throw new AgentSpawnError(
        `${this._params.agent} spawn failed: ${(e as Error).message ?? String(e)}`,
        e,
      );
    }
    this._child = child;

    // Honor the spawn() contract: async spawn failures (ENOENT for
    // missing binary, EACCES for unwritable cwd, etc.) come through
    // 'error' AFTER spawn() returns. Wait for either 'spawn' (Node
    // 16+) or 'error' before resolving so the failure becomes a
    // thrown promise rejection per the contract — never a stream
    // event. (Lessons archived from L1.T3 Codex review.)
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onSpawn = (): void => {
          if (settled) return;
          settled = true;
          child.removeListener('error', onError);
          resolve();
        };
        const onError = (err: Error): void => {
          if (settled) return;
          settled = true;
          child.removeListener('spawn', onSpawn);
          reject(
            new AgentSpawnError(
              `${this._params.agent} spawn failed: ${err.message}`,
              err,
            ),
          );
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
      });
    } catch (e) {
      // Async spawn failure — release lock + close transcript so
      // we don't leak.
      this._worktreeLock?.release();
      this._worktreeLock = null;
      if (this._transcript) {
        void this._transcript.close();
        this._transcript = null;
      }
      throw e;
    }

    this.pid = child.pid ?? null;
    // Register child in spawn registry for parent-exit SIGKILL fallback.
    if (this.pid !== null) {
      this._registryEntry = registerChild(this.pid, this._params.agent);
    }
    const sessionStart: CliAgentEvent = {
      kind: 'session_start',
      sessionId: this.sessionId,
      agent: this._params.agent,
      timestamp: Date.now(),
    };
    this._broadcast.emit(sessionStart);
    this._transcript?.write(sessionStart);
    this._wireChild(child);
  }

  private _wireChild(child: ChildProcess): void {
    let stdout = '';
    const wallTimer = setTimeout(() => {
      void this._terminateProcess('timeout', 'timeout');
    }, this._params.timeoutMs);

    if (this._params.signal) {
      this._signalListener = (): void => {
        void this.cancel('external_signal');
      };
      this._params.signal.addEventListener('abort', this._signalListener, {
        once: true,
      });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      this._onStdoutChunk(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this._stderrTail += chunk.toString('utf8');
      if (this._stderrTail.length > STDERR_TAIL_BYTES * 2) {
        this._stderrTail = this._stderrTail.slice(-STDERR_TAIL_BYTES);
      }
    });

    child.on('error', (err) => {
      clearTimeout(wallTimer);
      this._emitTerminal({
        kind: 'error',
        errorKind: 'spawn_failed',
        message: `${this._params.agent} child error: ${err.message}`,
        recoverable: false,
        timestamp: Date.now(),
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(wallTimer);
      this._processReaped = true;
      this._cleanupSignalListener();
      // Release safety resources BEFORE routing close (so terminal
      // emit + close-promise resolve happen with state already
      // cleaned up).
      if (this._registryEntry) {
        unregisterChild(this._registryEntry);
        this._registryEntry = null;
      }
      this._worktreeLock?.release();
      this._worktreeLock = null;
      this._routeClose(stdout, code, signal);
      // Resolve _closePromise NOW that the child is fully reaped.
      // (Previously we resolved on _emitTerminal which races with
      // streaming-terminal adapters — see Codex T5 review P1.)
      if (this._resolveClose) {
        this._resolveClose();
        this._resolveClose = null;
      }
      // Close transcript AFTER terminal event is emitted (so the
      // last write makes it to disk before fd closes).
      if (this._transcript) {
        const t = this._transcript;
        this._transcript = null;
        void t.close();
      }
    });
  }

  private _routeClose(
    stdout: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this._terminalEventEmitted) return;

    if (this._cancelled) {
      this._emitTerminal({
        kind: 'error',
        errorKind: this._cancelErrorKind,
        message:
          this._stderrTailTrimmed() ||
          `${this._params.agent} killed by us (signal=${signal ?? 'none'}, code=${code})`,
        recoverable: this._cancelErrorKind !== 'timeout',
        timestamp: Date.now(),
      });
      return;
    }

    if (signal && code === null) {
      this._emitTerminal({
        kind: 'error',
        errorKind: 'killed',
        message: `${this._params.agent} killed by external signal ${signal}`,
        recoverable: true,
        timestamp: Date.now(),
      });
      return;
    }

    this._handleNormalClose(stdout, code);
  }

  protected async _terminateProcess(
    reason: string,
    errorKind: 'killed' | 'timeout',
  ): Promise<void> {
    // Already fully done — both stream closed AND process reaped.
    // Idempotent fast path.
    if (this._processReaped) return;

    // If terminal event was already emitted (streaming adapter saw
    // agent_end early) but child is still alive, we MUST still kill
    // the child. Don't double-emit cancel_requested or terminal —
    // just send signals + wait for reap. (Codex T5 review P1: pre-fix,
    // this branch early-returned via `_closed` and left zombie children
    // after pi adapters streamed terminal mid-run.)
    if (this._terminalEventEmitted) {
      this._killChild();
      await this._closePromise;
      return;
    }

    // Already mid-cancel — just wait for reap.
    if (this._cancelled) {
      await this._closePromise;
      return;
    }

    this._cancelled = true;
    this._cancelErrorKind = errorKind;
    const cancelEvent: CliAgentEvent = {
      kind: 'cancel_requested',
      reason,
      timestamp: Date.now(),
    };
    this._broadcast.emit(cancelEvent);
    this._transcript?.write(cancelEvent);
    this._killChild();
    await this._closePromise;
  }

  /** Send SIGTERM, escalate to SIGKILL after the grace window if
   *  the child hasn't reaped yet. Idempotent — safe to call after
   *  the child has already exited. */
  private _killChild(): void {
    const child = this._child;
    if (!child || this._processReaped || !child.pid || child.killed) return;

    try {
      child.kill('SIGTERM');
    } catch {
      // already dead
    }

    const sigkillTimer = setTimeout(() => {
      if (!this._processReaped && this._child) {
        try {
          this._child.kill('SIGKILL');
        } catch {
          // race with 'close' fired between check and kill — fine
        }
      }
    }, SIGTERM_GRACE_MS);
    child.once('close', () => clearTimeout(sigkillTimer));
  }

  protected _emit(ev: CliAgentEvent): void {
    this._broadcast.emit(ev);
    this._transcript?.write(ev);
  }

  /** Emit the single terminal `result`/`error` event and close the
   *  consumer event stream. Does NOT resolve `_closePromise` — that
   *  happens when the child is fully reaped (in `'close'` handler).
   *  See `_terminalEventEmitted` JSDoc for the streaming-adapter
   *  rationale (Codex T5 review P1). */
  protected _emitTerminal(ev: CliAgentEvent): void {
    if (this._terminalEventEmitted) return;
    this._terminalEventEmitted = true;
    this._broadcast.emit(ev);
    this._broadcast.close();
    this._transcript?.write(ev);
  }

  protected _buildEnv(): NodeJS.ProcessEnv {
    const merged: NodeJS.ProcessEnv = { ...process.env };
    if (this._params.env) {
      for (const [k, v] of Object.entries(this._params.env)) {
        if (k.startsWith('MORION_HARNESS_')) continue;
        merged[k] = v;
      }
    }
    return merged;
  }

  protected _stderrTailTrimmed(): string {
    return this._stderrTail.length > STDERR_TAIL_BYTES
      ? this._stderrTail.slice(-STDERR_TAIL_BYTES)
      : this._stderrTail;
  }

  private _cleanupSignalListener(): void {
    if (this._signalListener && this._params.signal) {
      this._params.signal.removeEventListener('abort', this._signalListener);
      this._signalListener = null;
    }
  }
}

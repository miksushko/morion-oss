/**
 * Codex SDK-backed `AgentHandle` implementation. Extracted from
 * `../codex.ts` so the adapter shell stays small. State-machine
 * cohesion (event pump + cancel + reap + transcript) is preserved
 * intact — the class owns one Codex Thread from spawn to terminal.
 */

import { setTimeout as setTimer, clearTimeout as clearTimer } from 'node:timers';

import type {
  Codex as CodexType,
  Thread,
  ThreadEvent,
  ThreadOptions,
} from '@openai/codex-sdk';

import { AgentSpawnError, type AgentHandle } from '../../adapter.js';
import { EventBroadcast } from '../../event-broadcast.js';
import type { AgentName, CliAgentEvent } from '../../events.js';
import { TranscriptWriter, transcriptPathFor } from '../../transcript.js';
import { DEFAULT_TIMEOUT_MS } from './agent-config.js';
import {
  completedItemToEvent,
  startedItemToEvent,
} from './event-mappers.js';

export interface CodexSdkHandleParams {
  codex: CodexType;
  thread: Thread;
  binPath: string;
  provisionalSessionId: string;
  agent: AgentName;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
  transcriptDir?: string;
  outputSchema?: unknown;
  isResume: boolean;
}

export class CodexSdkAgentHandle implements AgentHandle {
  readonly adapter: AgentName = 'codex';
  sessionId: string;
  readonly pid: number | null = null;

  private readonly _codex: CodexType;
  private readonly _thread: Thread;
  private readonly _binPath: string;
  private readonly _prompt: string;
  private readonly _outputSchema?: unknown;
  private readonly _transcriptDir?: string;
  private readonly _broadcast = new EventBroadcast();
  private readonly _abortCtrl = new AbortController();
  private readonly _closePromise: Promise<void>;
  private _resolveClose: (() => void) | null = null;
  private _cost = 0;
  private _terminalEventEmitted = false;
  private _processReaped = false;
  private _cancelled = false;
  private _cancelErrorKind: 'killed' | 'timeout' = 'killed';
  private _wallTimer: ReturnType<typeof setTimer> | null = null;
  private _externalSignalListener: (() => void) | null = null;
  private _signal?: AbortSignal;
  private _transcript: TranscriptWriter | null = null;
  private _sessionStartEmitted = false;
  private _finalText = '';

  static async _start(
    params: CodexSdkHandleParams,
  ): Promise<CodexSdkAgentHandle> {
    const handle = new CodexSdkAgentHandle(params);
    await handle._begin();
    return handle;
  }

  private constructor(params: CodexSdkHandleParams) {
    this._codex = params.codex;
    this._thread = params.thread;
    this._binPath = params.binPath;
    this._prompt = params.prompt;
    this._outputSchema = params.outputSchema;
    this._transcriptDir = params.transcriptDir;
    this._signal = params.signal;
    this.sessionId = params.provisionalSessionId;
    this._closePromise = new Promise<void>((resolve) => {
      this._resolveClose = resolve;
    });
    // Wall-clock timeout — same shape as the AbstractAgentHandle
    // contract for parity with the other adapters.
    this._wallTimer = setTimer(() => {
      this._cancelErrorKind = 'timeout';
      void this._cancel('timeout');
    }, params.timeoutMs);
    if (this._signal) {
      this._externalSignalListener = (): void => {
        void this._cancel('external_signal');
      };
      this._signal.addEventListener('abort', this._externalSignalListener, {
        once: true,
      });
    }
  }

  get events(): AsyncIterable<CliAgentEvent> {
    return {
      [Symbol.asyncIterator]: () => this._broadcast.iterate(),
    };
  }

  get exited(): Promise<void> {
    return this._closePromise;
  }

  async cancel(reason: string = 'parent_handle_cancel'): Promise<void> {
    this._cancelErrorKind = 'killed';
    await this._cancel(reason);
  }

  /** Resume the conversation on the same thread. The SDK persists
   *  threads in `~/.codex/sessions/`, so this works across process
   *  restarts as long as the same `codex` binary + auth are in place. */
  async resume(injectedMessage?: string): Promise<AgentHandle> {
    const threadId = this.sessionId;
    const threadOptions: ThreadOptions = {
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
    };
    const nextThread = this._codex.resumeThread(threadId, threadOptions);
    return CodexSdkAgentHandle._start({
      codex: this._codex,
      thread: nextThread,
      binPath: this._binPath,
      provisionalSessionId: threadId,
      agent: 'codex',
      prompt: injectedMessage ?? '',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      transcriptDir: this._transcriptDir,
      outputSchema: this._outputSchema,
      isResume: true,
    });
  }

  getCost(): number {
    return this._cost;
  }

  // -------------------------------------------------------------------
  // Internal lifecycle
  // -------------------------------------------------------------------

  private async _begin(): Promise<void> {
    if (this._transcriptDir) {
      try {
        this._transcript = new TranscriptWriter(
          transcriptPathFor(this._transcriptDir, this.sessionId),
        );
        await this._transcript.open();
      } catch {
        // Transcript persistence is best-effort.
        this._transcript = null;
      }
    }

    // SDK call. Throws synchronously on bad options, asynchronously on
    // codex-binary-missing / auth-missing. Either way, surface as
    // AgentSpawnError so callers don't need to know about the SDK.
    let streamed: { events: AsyncGenerator<ThreadEvent> };
    try {
      streamed = await this._thread.runStreamed(this._prompt, {
        signal: this._abortCtrl.signal,
        ...(this._outputSchema != null
          ? { outputSchema: this._outputSchema }
          : {}),
      });
    } catch (e) {
      this._cleanupTimers();
      if (this._transcript) {
        void this._transcript.close();
        this._transcript = null;
      }
      throw new AgentSpawnError(
        `codex SDK runStreamed failed: ${(e as Error).message ?? String(e)}`,
        e,
      );
    }

    // Pump events in the background; the spawn() promise resolves now.
    // Per AgentHandle contract `events` becomes immediately iterable,
    // and consumers may iterate or ignore — the broadcast still feeds
    // transcript via `_emit`.
    void this._pumpEvents(streamed.events);
  }

  private async _pumpEvents(
    events: AsyncGenerator<ThreadEvent>,
  ): Promise<void> {
    try {
      for await (const ev of events) {
        const mapped = this._mapSdkEvent(ev);
        if (mapped) this._emit(mapped);
        if (this._terminalEventEmitted) break;
      }
    } catch (e) {
      // The SDK throws when its child errors out of band (binary
      // missing, codex login required, etc). Map to terminal error so
      // consumers always see a terminal event.
      if (!this._terminalEventEmitted) {
        this._emitTerminal({
          kind: 'error',
          errorKind: 'sdk_error',
          message: `codex SDK error: ${(e as Error).message ?? String(e)}`,
          recoverable: false,
          timestamp: Date.now(),
        });
      }
    }
    // Stream ended without a terminal event (clean SDK shutdown after
    // turn.completed). Synthesize one from the final agent_message
    // accumulated during the run.
    if (!this._terminalEventEmitted) {
      this._emitTerminal({
        kind: 'result',
        exitCode: 0,
        summary: this._finalText,
        costUsd: 0,
        terminalReason: 'completed',
        timestamp: Date.now(),
      });
    }
    this._finishReap();
  }

  private _mapSdkEvent(ev: ThreadEvent): CliAgentEvent | null {
    const now = Date.now();
    switch (ev.type) {
      case 'thread.started':
        // Switch our public sessionId to the SDK thread_id so callers
        // who pass it back in `resumeSessionId` round-trip correctly.
        this.sessionId = ev.thread_id;
        if (!this._sessionStartEmitted) {
          this._sessionStartEmitted = true;
          return {
            kind: 'session_start',
            sessionId: ev.thread_id,
            agent: this.adapter,
            timestamp: now,
          };
        }
        return null;
      case 'turn.started':
        return null;
      case 'turn.completed':
        // SDK doesn't surface USD. Keep cost = 0 (informational).
        // The terminal `result` is synthesized in _pumpEvents tail.
        return null;
      case 'turn.failed':
        this._emitTerminal({
          kind: 'error',
          errorKind: 'turn_failed',
          message: ev.error?.message ?? 'codex turn failed',
          recoverable: false,
          timestamp: now,
        });
        return null;
      case 'error':
        this._emitTerminal({
          kind: 'error',
          errorKind: 'sdk_error',
          message: ev.message ?? 'codex SDK stream error',
          recoverable: false,
          timestamp: now,
        });
        return null;
      case 'item.started':
        return startedItemToEvent(ev.item, now);
      case 'item.completed':
        return completedItemToEvent(
          ev.item,
          (text) => {
            this._finalText = text;
          },
          now,
        );
      case 'item.updated':
        return null;
      default:
        return null;
    }
  }

  /** Internal — child finished (terminal event emitted, stream drained).
   *  Resolves `_closePromise` so awaiters of `handle.exited` unblock. */
  private _finishReap(): void {
    if (this._processReaped) return;
    this._processReaped = true;
    this._cleanupTimers();
    if (this._resolveClose) {
      this._resolveClose();
      this._resolveClose = null;
    }
    if (this._transcript) {
      const t = this._transcript;
      this._transcript = null;
      void t.close();
    }
  }

  private async _cancel(reason: string): Promise<void> {
    if (this._processReaped) return;
    if (this._cancelled) {
      await this._closePromise;
      return;
    }
    this._cancelled = true;
    this._emit({
      kind: 'cancel_requested',
      reason,
      timestamp: Date.now(),
    });
    // Abort the SDK signal — the SDK SIGTERMs the underlying Rust
    // child. We also emit the terminal error here so consumers don't
    // wait on the pump's tail (the SDK may not produce a turn.failed
    // event on abort, depending on its abort handling).
    this._abortCtrl.abort();
    this._emitTerminal({
      kind: 'error',
      errorKind: this._cancelErrorKind,
      message: `codex cancelled (${reason})`,
      recoverable: this._cancelErrorKind !== 'timeout',
      timestamp: Date.now(),
    });
    this._finishReap();
  }

  private _cleanupTimers(): void {
    if (this._wallTimer) {
      clearTimer(this._wallTimer);
      this._wallTimer = null;
    }
    if (this._externalSignalListener && this._signal) {
      this._signal.removeEventListener('abort', this._externalSignalListener);
      this._externalSignalListener = null;
    }
  }

  private _emit(ev: CliAgentEvent): void {
    this._broadcast.emit(ev);
    this._transcript?.write(ev);
  }

  private _emitTerminal(ev: CliAgentEvent): void {
    if (this._terminalEventEmitted) return;
    this._terminalEventEmitted = true;
    this._broadcast.emit(ev);
    this._broadcast.close();
    this._transcript?.write(ev);
  }
}

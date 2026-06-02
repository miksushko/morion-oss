import {
  AgentSpawnError,
  type AgentHandle,
} from '../../adapter.js';
import { AbstractAgentHandle } from '../../abstract-handle.js';
import { DEFAULT_ALLOWED_TOOLS, mapToolNames, type PiHandleParams } from './agent-config.js';
import { mapPiEventToHarness } from './event-mappers.js';

/**
 * Pi agent handle — owns the spawned process lifecycle + LF-JSONL
 * stream parsing + event translation via mapPiEventToHarness.
 * Extracted from adapters/pi.ts during the 2026-05-16 split (Morion
 * ticket 01KRQYSGYJM48WC1NJTTHZ9XNE).
 */
export class PiAgentHandle extends AbstractAgentHandle {
  private readonly _piParams: PiHandleParams;
  /** Carry buffer for partial LF-JSONL lines across chunk
   *  boundaries. */
  private _lineBuffer = '';
  /** `tool_execution_start` timestamps keyed by `toolCallId` so
   *  we can compute `durationMs` at `tool_execution_end`. */
  private readonly _toolStartTimestamps = new Map<string, number>();

  static async _start(params: PiHandleParams): Promise<PiAgentHandle> {
    const handle = new PiAgentHandle(params);
    await handle._spawnChild();
    return handle;
  }

  private constructor(params: PiHandleParams) {
    super(params);
    this._piParams = params;
  }

  protected _buildArgs(): string[] {
    const p = this._piParams;
    const args: string[] = ['-p', '--mode', 'json'];
    if (p.allowedTools !== undefined) {
      args.push('--tools', mapToolNames(p.allowedTools));
    } else {
      args.push('--tools', mapToolNames(DEFAULT_ALLOWED_TOOLS));
    }
    if (p.provider) {
      args.push('--provider', p.provider);
    }
    if (p.model) {
      args.push('--model', p.model);
    }
    // Pi `--session <id>` semantics:
    //   - **Resume mode**: tells pi to continue an existing session
    //     by id. Used after agent paused (e.g. ask_user wait in L3).
    //   - **Fresh mode**: we used to pass our pre-allocated UUID
    //     here too, but Codex T5 review flagged this as risky
    //     without real-pi verification — pi may treat it as
    //     "resume non-existent session" and error. We now omit
    //     `--session` on fresh runs and let pi assign its own id;
    //     we capture the authoritative id from the `session` event
    //     in the JSONL stream. Resume uses that captured id.
    //
    // TODO L1.T10 real-pi smoke: verify `pi --session <new-uuid>`
    // on fresh runs DOES create rather than error. If it does
    // create, we can pass our UUID for caller-side tracking
    // continuity. For now, fresh = pi-assigned.
    if (p.mode === 'resume') {
      // On resume, `this.sessionId` is pi's authoritative id (set
      // by `resume()` before constructing the new handle). On fresh
      // it would be the caller's UUID, but we don't reach here for
      // fresh runs — the conditional above already filters.
      args.push('--session', this.sessionId);
    }
    args.push(p.prompt);
    return args;
  }

  /** Pi's authoritative session id (captured from the first
   *  `session` event in the stream). Used as the `sessionId` of
   *  the new handle on `resume()` so its `--session` arg points
   *  at pi's actual session, not our caller-side UUID. */
  private _piAuthoritativeSessionId: string | null = null;

  protected override _onStdoutChunk(chunk: string): void {
    this._lineBuffer += chunk;
    let nlIdx: number;
    while ((nlIdx = this._lineBuffer.indexOf('\n')) >= 0) {
      const line = this._lineBuffer.slice(0, nlIdx);
      this._lineBuffer = this._lineBuffer.slice(nlIdx + 1);
      this._processPiLine(line);
    }
  }

  protected _handleNormalClose(_stdout: string, code: number | null): void {
    // If a terminal event was already emitted via the stream
    // (`agent_end`), `_emitTerminal` short-circuits via
    // `_terminalEventEmitted` — this handler still runs but is a
    // no-op for that case (the route check above already filters).
    //
    // Reach this branch only when the stream ended without
    // `agent_end`: pi crashed, exited early, malformed output, etc.
    // Surface as parse_failed so the workflow runner has a clear
    // signal vs a clean completion.
    if (this._terminalEventEmitted) return;
    if (code !== 0 && code !== null) {
      this._emitTerminal({
        kind: 'error',
        errorKind: 'non_zero_exit',
        message:
          this._stderrTailTrimmed() || `pi exited with code ${code}`,
        recoverable: false,
        timestamp: Date.now(),
      });
      return;
    }
    this._emitTerminal({
      kind: 'error',
      errorKind: 'parse_failed',
      message:
        this._stderrTailTrimmed() ||
        'pi exited cleanly without producing an agent_end event',
      recoverable: false,
      timestamp: Date.now(),
    });
  }

  private _processPiLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: { type: string; [k: string]: unknown };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Pi sometimes interleaves a non-JSON line (warning text,
      // banner) — skip silently. The terminal event still comes
      // through the structured stream.
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed)) {
      return;
    }
    const ev = mapPiEventToHarness(parsed, this._toolStartTimestamps);
    if (!ev) return;
    // Capture pi's authoritative session id when it arrives. This
    // is what we'll pass as `--session` on resume — see _buildArgs.
    if (
      ev.kind === 'session_start' &&
      this._piAuthoritativeSessionId === null
    ) {
      this._piAuthoritativeSessionId = ev.sessionId;
    }
    if (ev.kind === 'result' || ev.kind === 'error') {
      this._cost = ev.kind === 'result' ? ev.costUsd : this._cost;
      this._emitTerminal(ev);
    } else {
      this._emit(ev);
    }
  }

  override async resume(injectedMessage?: string): Promise<AgentHandle> {
    // Streaming adapters: terminal event may arrive BEFORE process
    // reap. Guard on `_processReaped` so resume doesn't race into
    // a same-worktree spawn while the prior child still holds the
    // lockfile / git state. (Codex T10 review P1.)
    if (!this._processReaped) {
      throw new AgentSpawnError(
        'cannot resume — process has not been reaped yet. Await `handle.exited` before calling resume().',
      );
    }
    if (this._piAuthoritativeSessionId === null) {
      throw new AgentSpawnError(
        'cannot resume — pi never emitted a session event. The original run produced no session id to resume.',
      );
    }
    // Override sessionId with pi's authoritative id so the new
    // handle's `--session` arg points at pi's actual session, not
    // our caller-side UUID. The new handle's `handle.sessionId`
    // becomes pi's id (resumed sessions ARE pi-side from then on).
    return PiAgentHandle._start({
      ...this._piParams,
      sessionId: this._piAuthoritativeSessionId,
      mode: 'resume',
      prompt: injectedMessage ?? '',
    });
  }
}

/**
 * `OpencodeAgentHandle` — AgentHandle state machine for the opencode CLI.
 * Streaming NDJSON parser + line buffer + resume-via-session-id support.
 * Extracted from `../opencode.ts` (2026-05-16, mirror of codex split).
 */

import { AgentSpawnError, type AgentHandle } from '../../adapter.js';
import { AbstractAgentHandle } from '../../abstract-handle.js';
import { mapOpencodeEventToHarness } from './event-mappers.js';
import type { HandleParams } from './agent-config.js';

export class OpencodeAgentHandle extends AbstractAgentHandle {
  private readonly _opencodeParams: HandleParams;
  private _lineBuffer = '';
  private _opencodeAuthoritativeSessionId: string | null = null;
  private readonly _toolStartTimestamps = new Map<string, number>();

  static async _start(params: HandleParams): Promise<OpencodeAgentHandle> {
    const handle = new OpencodeAgentHandle(params);
    await handle._spawnChild();
    return handle;
  }

  private constructor(params: HandleParams) {
    super(params);
    this._opencodeParams = params;
  }

  protected _buildArgs(): string[] {
    const p = this._opencodeParams;
    const args: string[] = ['run'];
    if (p.mode === 'resume') {
      // Resume by session id (captured from stream on first run).
      args.push('--session', this.sessionId);
    }
    args.push('--format', 'json', '--dangerously-skip-permissions');
    if (p.model) {
      args.push('--model', p.model);
    }
    args.push(p.prompt);
    return args;
  }

  protected override _onStdoutChunk(chunk: string): void {
    this._lineBuffer += chunk;
    let nlIdx: number;
    while ((nlIdx = this._lineBuffer.indexOf('\n')) >= 0) {
      const line = this._lineBuffer.slice(0, nlIdx);
      this._lineBuffer = this._lineBuffer.slice(nlIdx + 1);
      this._processOpencodeLine(line);
    }
  }

  protected _handleNormalClose(stdout: string, code: number | null): void {
    if (this._terminalEventEmitted) return;

    // Flush remaining line buffer (last line may not end with \n).
    if (this._lineBuffer.trim().length > 0) {
      this._processOpencodeLine(this._lineBuffer);
      this._lineBuffer = '';
    }
    if (this._terminalEventEmitted) return;

    if (code !== 0 && code !== null) {
      this._emitTerminal({
        kind: 'error',
        errorKind: 'non_zero_exit',
        message:
          this._stderrTailTrimmed() || `opencode exited with code ${code}`,
        recoverable: false,
        timestamp: Date.now(),
      });
      return;
    }

    // Clean exit but no terminal event in stream. Two possibilities:
    //   (a) opencode emits a single envelope (claude-style) — we
    //       just dropped it because parsing as line-by-line missed
    //       a non-streaming single-shot.
    //   (b) opencode emitted no events at all (silent run).
    // Try one more parse on full stdout as a single JSON document.
    const trimmed = stdout.trim();
    if (trimmed.length > 0 && trimmed.startsWith('{')) {
      try {
        const single = JSON.parse(trimmed) as Record<string, unknown>;
        const ev = mapOpencodeEventToHarness(
          single,
          this._toolStartTimestamps,
        );
        if (ev && (ev.kind === 'result' || ev.kind === 'error')) {
          this._emitTerminal(ev);
          return;
        }
      } catch {
        // not single-envelope; fall through
      }
    }

    // Surface as result-with-stdout-summary so workflow runner has
    // SOMETHING to work with, vs hard-failing on schema unknowns.
    this._emitTerminal({
      kind: 'result',
      exitCode: code ?? 0,
      summary: trimmed,
      costUsd: 0,
      terminalReason: 'completed',
      timestamp: Date.now(),
    });
  }

  override async resume(injectedMessage?: string): Promise<AgentHandle> {
    // Same race guard as pi — streaming adapter, see resume() JSDoc
    // in PiAdapter for full rationale (Codex T10 review P1).
    if (!this._processReaped) {
      throw new AgentSpawnError(
        'cannot resume — process has not been reaped yet. Await `handle.exited` before calling resume().',
      );
    }
    if (this._opencodeAuthoritativeSessionId === null) {
      throw new AgentSpawnError(
        'cannot resume — opencode never emitted a session event. The original run produced no session id to resume.',
      );
    }
    return OpencodeAgentHandle._start({
      ...this._opencodeParams,
      sessionId: this._opencodeAuthoritativeSessionId,
      mode: 'resume',
      prompt: injectedMessage ?? '',
    });
  }

  private _processOpencodeLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // opencode may interleave warning text — skip silently.
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;

    const ev = mapOpencodeEventToHarness(parsed, this._toolStartTimestamps);
    if (!ev) return;

    if (
      ev.kind === 'session_start' &&
      this._opencodeAuthoritativeSessionId === null
    ) {
      this._opencodeAuthoritativeSessionId = ev.sessionId;
    }
    if (ev.kind === 'result' || ev.kind === 'error') {
      this._cost = ev.kind === 'result' ? ev.costUsd : this._cost;
      this._emitTerminal(ev);
    } else {
      this._emit(ev);
    }
  }
}

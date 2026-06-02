import { describe, it, expect } from 'vitest';

import { mapOpencodeEventToHarness } from '../../src/core/auto-code/harness/adapters/opencode.js';

/**
 * mapOpencodeEventToHarness — pure unit tests over the real opencode
 * `--format json` schema. No subprocess; no stub binary; just the
 * event mapper.
 */

describe('mapOpencodeEventToHarness — real opencode schema (L1.T6)', () => {
  it('step_start with sessionID → session_start', () => {
    const ts = new Map<string, number>();
    const ev = mapOpencodeEventToHarness(
      {
        type: 'step_start',
        timestamp: 1700000000000,
        sessionID: 'ses_abc',
        part: { id: 'prt_1', type: 'step-start', snapshot: 'sha-1' },
      },
      ts,
    );
    expect(ev?.kind).toBe('session_start');
    if (ev?.kind === 'session_start') {
      expect(ev.sessionId).toBe('ses_abc');
      expect(ev.agent).toBe('opencode');
    }
  });

  it('tool_use (status=completed) → tool_end with computed durationMs', () => {
    const ts = new Map<string, number>();
    const ev = mapOpencodeEventToHarness(
      {
        type: 'tool_use',
        timestamp: 1700000000000,
        sessionID: 'ses_abc',
        part: {
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'echo hello' },
            output: 'hello\n',
            metadata: { exit: 0 },
            time: { start: 1700000000000, end: 1700000000050 },
          },
        },
      },
      ts,
    );
    expect(ev?.kind).toBe('tool_end');
    if (ev?.kind === 'tool_end') {
      expect(ev.toolName).toBe('bash');
      expect(ev.result).toBe('hello\n');
      expect(ev.durationMs).toBe(50);
    }
  });

  it('tool_use (status=running) → null (intermediate state, not completed)', () => {
    const ts = new Map<string, number>();
    const ev = mapOpencodeEventToHarness(
      {
        type: 'tool_use',
        timestamp: 1,
        sessionID: 'ses_abc',
        part: {
          tool: 'bash',
          state: { status: 'running', input: { command: 'ls' } },
        },
      },
      ts,
    );
    expect(ev).toBeNull();
  });

  it('text event → text_delta', () => {
    const ts = new Map<string, number>();
    const ev = mapOpencodeEventToHarness(
      {
        type: 'text',
        timestamp: 1700000000000,
        sessionID: 'ses_abc',
        part: { type: 'text', text: '```\nhello\n```' },
      },
      ts,
    );
    expect(ev?.kind).toBe('text_delta');
    if (ev?.kind === 'text_delta') {
      expect(ev.text).toBe('```\nhello\n```');
    }
  });

  it('step_finish (reason=stop) → terminal result with cost', () => {
    const ts = new Map<string, number>();
    const ev = mapOpencodeEventToHarness(
      {
        type: 'step_finish',
        timestamp: 1700000000000,
        sessionID: 'ses_abc',
        part: {
          type: 'step-finish',
          reason: 'stop',
          cost: 0.001,
          tokens: { input: 671, output: 8, reasoning: 0, cache: { read: 21415, write: 0 } },
        },
      },
      ts,
    );
    expect(ev?.kind).toBe('result');
    if (ev?.kind === 'result') {
      expect(ev.terminalReason).toBe('completed');
      expect(ev.costUsd).toBeCloseTo(0.001);
    }
  });

  it('step_finish (reason=tool-calls) → null (intermediate boundary, not terminal)', () => {
    const ts = new Map<string, number>();
    const ev = mapOpencodeEventToHarness(
      {
        type: 'step_finish',
        timestamp: 1,
        sessionID: 'ses_abc',
        part: { type: 'step-finish', reason: 'tool-calls', cost: 0.0005 },
      },
      ts,
    );
    expect(ev).toBeNull();
  });

  it('error event → terminal error with message lifted from error.data.message', () => {
    const ts = new Map<string, number>();
    const ev = mapOpencodeEventToHarness(
      {
        type: 'error',
        timestamp: 1700000000000,
        sessionID: 'ses_abc',
        error: {
          name: 'APIError',
          data: { message: 'Rate limit exceeded', statusCode: 429 },
        },
      },
      ts,
    );
    expect(ev?.kind).toBe('error');
    if (ev?.kind === 'error') {
      expect(ev.errorKind).toBe('non_zero_exit');
      expect(ev.message).toBe('Rate limit exceeded');
    }
  });

  it('missing type → null', () => {
    expect(mapOpencodeEventToHarness({}, new Map())).toBeNull();
  });

  it('unknown type → null (forward-compat for new opencode versions)', () => {
    expect(
      mapOpencodeEventToHarness({ type: 'mystery_new_event' }, new Map()),
    ).toBeNull();
  });

  it('step_start without sessionID → null (defensive)', () => {
    const ts = new Map<string, number>();
    const ev = mapOpencodeEventToHarness(
      { type: 'step_start', timestamp: 1, part: { id: 'x' } },
      ts,
    );
    expect(ev).toBeNull();
  });
});

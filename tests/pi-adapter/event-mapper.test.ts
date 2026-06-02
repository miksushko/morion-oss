import { describe, it, expect } from 'vitest';
import { mapPiEventToHarness } from '../../src/core/auto-code/harness/adapters/pi.js';

/**
 * Pure-function unit tests for `mapPiEventToHarness`. No subprocess
 * spawn — adapter integration lives in the sibling scenario files.
 *
 * Extracted from `tests/pi-adapter.test.ts` (2026-05-16, ticket
 * `01KRR8FGAMBFV8QC54PW1KSMQ2`).
 */

describe('mapPiEventToHarness', () => {
  it('session → session_start with pi id', () => {
    const ts = new Map<string, number>();
    const ev = mapPiEventToHarness(
      {
        type: 'session',
        version: 1,
        id: 'sess-xyz',
        timestamp: 1700000000000,
        cwd: '/tmp',
      },
      ts,
    );
    expect(ev?.kind).toBe('session_start');
    if (ev?.kind === 'session_start') {
      expect(ev.sessionId).toBe('sess-xyz');
      expect(ev.agent).toBe('pi');
      expect(ev.timestamp).toBe(1700000000000);
    }
  });

  it('tool_execution_start tracks start timestamp', () => {
    const ts = new Map<string, number>();
    const ev = mapPiEventToHarness(
      {
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'read',
        args: { path: '/x' },
      },
      ts,
    );
    expect(ev?.kind).toBe('tool_start');
    expect(ts.has('tc1')).toBe(true);
  });

  it('tool_execution_end computes durationMs from tracked start', async () => {
    const ts = new Map<string, number>();
    mapPiEventToHarness(
      {
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'bash',
        args: { cmd: 'echo' },
      },
      ts,
    );
    await new Promise((r) => setTimeout(r, 20));
    const ev = mapPiEventToHarness(
      {
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        toolName: 'bash',
        result: 'echo\n',
        isError: false,
      },
      ts,
    );
    expect(ev?.kind).toBe('tool_end');
    if (ev?.kind === 'tool_end') {
      expect(ev.durationMs).toBeGreaterThan(0);
      expect(ev.toolName).toBe('bash');
      expect(ev.result).toBe('echo\n');
    }
    expect(ts.has('tc1')).toBe(false);
  });

  it('message_end (assistant role, string content) → message', () => {
    const ts = new Map<string, number>();
    const ev = mapPiEventToHarness(
      {
        type: 'message_end',
        message: { role: 'assistant', content: 'hello' },
      },
      ts,
    );
    expect(ev?.kind).toBe('message');
    if (ev?.kind === 'message') {
      expect(ev.role).toBe('assistant');
      expect(ev.content).toBe('hello');
    }
  });

  it('message_end (block content) flattens to text', () => {
    const ts = new Map<string, number>();
    const ev = mapPiEventToHarness(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'part one ' },
            { type: 'text', text: 'part two' },
          ],
        },
      },
      ts,
    );
    expect(ev?.kind).toBe('message');
    if (ev?.kind === 'message') {
      expect(ev.content).toBe('part one part two');
    }
  });

  it('message_end with unknown role → null', () => {
    const ts = new Map<string, number>();
    const ev = mapPiEventToHarness(
      { type: 'message_end', message: { role: 'mystery', content: 'x' } },
      ts,
    );
    expect(ev).toBeNull();
  });

  it('agent_end → result with extracted final assistant text + cost 0', () => {
    const ts = new Map<string, number>();
    const ev = mapPiEventToHarness(
      {
        type: 'agent_end',
        messages: [
          { role: 'user', content: 'do x' },
          { role: 'assistant', content: 'first turn' },
          { role: 'user', content: 'now y' },
          { role: 'assistant', content: 'second turn — final' },
        ],
      },
      ts,
    );
    expect(ev?.kind).toBe('result');
    if (ev?.kind === 'result') {
      expect(ev.exitCode).toBe(0);
      expect(ev.terminalReason).toBe('completed');
      expect(ev.costUsd).toBe(0);
      expect(ev.summary).toBe('second turn — final');
    }
  });

  it('lifecycle bookkeeping events return null', () => {
    const ts = new Map<string, number>();
    const types = [
      'agent_start',
      'turn_start',
      'message_start',
      'message_update',
      'tool_execution_update',
      'queue_update',
      'turn_end',
      'compaction_start',
      'compaction_end',
      'auto_retry_start',
      'auto_retry_end',
    ];
    for (const type of types) {
      expect(mapPiEventToHarness({ type }, ts)).toBeNull();
    }
  });

  it('unknown type → null', () => {
    const ts = new Map<string, number>();
    expect(
      mapPiEventToHarness({ type: 'mystery_event' }, ts),
    ).toBeNull();
  });
});

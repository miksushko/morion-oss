import { describe, it, expect } from 'vitest';
import {
  isRecoverableErrorKind,
  consumeUntilTerminal,
  sleep,
  findOutboundByLabel,
  formatReopenReason,
} from '../src/core/auto-code/workflows/runner-helpers.js';
import type {
  CliAgentEvent,
  ResultEvent,
  ErrorEvent,
} from '../src/core/auto-code/harness/events.js';
import type { WorkflowEdge } from '../src/core/auto-code/workflows/types/index.js';

describe('isRecoverableErrorKind', () => {
  it.each([
    ['binary_not_found', true],
    ['required_package_missing', true],
    ['codex_ink_crash', true],
    ['spawn_timeout', false],
    ['budget', false],
    ['', false],
  ])('classifies %s -> %s', (kind, expected) => {
    expect(isRecoverableErrorKind(kind)).toBe(expected);
  });

  it.each([null, undefined, 42, {}, [], true])(
    'returns false for non-string %s',
    (value) => {
      expect(isRecoverableErrorKind(value)).toBe(false);
    },
  );
});

describe('consumeUntilTerminal', () => {
  const ts = 1000;

  async function* fromArray(events: CliAgentEvent[]): AsyncIterable<CliAgentEvent> {
    for (const ev of events) yield ev;
  }

  it('returns the first result event', async () => {
    const result: ResultEvent = {
      kind: 'result',
      timestamp: ts,
      durationMs: 1,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    };
    const got = await consumeUntilTerminal(fromArray([result]));
    expect(got).toBe(result);
  });

  it('returns the first error event', async () => {
    const err: ErrorEvent = {
      kind: 'error',
      errorKind: 'spawn_timeout',
      message: 'boom',
      recoverable: false,
      timestamp: ts,
    };
    const got = await consumeUntilTerminal(fromArray([err]));
    expect(got).toBe(err);
  });

  it('skips non-terminal events until the terminal one', async () => {
    const events: CliAgentEvent[] = [
      { kind: 'session_start', sessionId: 'sess-x', timestamp: ts },
      { kind: 'text_delta', delta: 'hi', timestamp: ts },
      {
        kind: 'result',
        timestamp: ts,
        durationMs: 1,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
      },
    ];
    const got = await consumeUntilTerminal(fromArray(events));
    expect(got.kind).toBe('result');
  });

  it('invokes onSessionId for session_start events before the terminal', async () => {
    const seen: string[] = [];
    const events: CliAgentEvent[] = [
      { kind: 'session_start', sessionId: 'cli-internal-1', timestamp: ts },
      {
        kind: 'result',
        timestamp: ts,
        durationMs: 1,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
      },
    ];
    await consumeUntilTerminal(fromArray(events), (id) => seen.push(id));
    expect(seen).toEqual(['cli-internal-1']);
  });

  it('synthesises a stream_closed_without_terminal error when the stream ends silently', async () => {
    const got = (await consumeUntilTerminal(fromArray([
      { kind: 'session_start', sessionId: 'x', timestamp: ts },
    ]))) as ErrorEvent;
    expect(got.kind).toBe('error');
    expect(got.errorKind).toBe('stream_closed_without_terminal');
    expect(got.recoverable).toBe(false);
  });

  it('does not call onSessionId when omitted', async () => {
    // Smoke — no throw, no observable effect.
    const got = await consumeUntilTerminal(fromArray([
      { kind: 'session_start', sessionId: 'x', timestamp: ts },
      {
        kind: 'result',
        timestamp: ts,
        durationMs: 1,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
      },
    ]));
    expect(got.kind).toBe('result');
  });
});

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(20);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });

  it('resolves immediately on 0ms', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});

describe('findOutboundByLabel', () => {
  const edges: WorkflowEdge[] = [
    { from: 'a', to: 'b', on: 'success' },
    { from: 'a', to: 'c', on: 'failure' },
    { from: 'b', to: 'd', on: 'success' },
  ];

  it('returns the matching target', () => {
    expect(findOutboundByLabel(edges, 'a', 'success')).toBe('b');
    expect(findOutboundByLabel(edges, 'a', 'failure')).toBe('c');
    expect(findOutboundByLabel(edges, 'b', 'success')).toBe('d');
  });

  it('returns null when no edge matches', () => {
    expect(findOutboundByLabel(edges, 'a', 'missing')).toBeNull();
    expect(findOutboundByLabel(edges, 'nonexistent', 'success')).toBeNull();
  });

  it('returns null on empty edge list', () => {
    expect(findOutboundByLabel([], 'a', 'success')).toBeNull();
  });

  it('returns the first match when duplicates exist (defensive)', () => {
    const dup: WorkflowEdge[] = [
      { from: 'a', to: 'first', on: 'go' },
      { from: 'a', to: 'second', on: 'go' },
    ];
    expect(findOutboundByLabel(dup, 'a', 'go')).toBe('first');
  });
});

describe('formatReopenReason', () => {
  it('wraps the reviewer reason in a banner with the source stage id', () => {
    const got = formatReopenReason('please rerun tests', 'review');
    expect(got).toBe(
      [
        '--- Previous reviewer feedback (from "review" stage) ---',
        'please rerun tests',
        '',
        'Address the feedback above and try again.',
      ].join('\n'),
    );
  });

  it('substitutes a placeholder when reviewer feedback is empty', () => {
    const got = formatReopenReason('', 'review');
    expect(got).toContain('(no reason provided by the reviewer)');
  });

  it('substitutes a placeholder when reviewer feedback is whitespace-only', () => {
    const got = formatReopenReason('   \n  \t  ', 'review');
    expect(got).toContain('(no reason provided by the reviewer)');
  });

  it('preserves the stage id verbatim in the banner', () => {
    const got = formatReopenReason('x', 'tricky-stage_2');
    expect(got).toContain('from "tricky-stage_2" stage');
  });
});

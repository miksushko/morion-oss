import { describe, it, expect } from 'vitest';
import {
  CliAgentEventSchema,
  parseEventLine,
  parseEventObject,
} from '../src/core/auto-code/harness/events-parse.js';
import type { CliAgentEvent } from '../src/core/auto-code/harness/events.js';

/**
 * L1.T2 — runtime parsing of CliAgentEvent. Verifies:
 *
 *   1. Each of the 8 event kinds round-trips through the schema with
 *      its documented field set intact.
 *   2. `parseEventLine` is lenient — returns `null` for empty,
 *      whitespace, malformed JSON, missing required fields, mistyped
 *      fields, and unknown kinds (no throws).
 *   3. Unknown extra fields are stripped silently (forward-compat
 *      with future CLI output schema additions).
 *   4. Type guards from L1.T1 narrow correctly on parsed events.
 */

const NOW = 1_700_000_000_000;

const SAMPLES: { name: string; ev: CliAgentEvent; line: string }[] = [
  {
    name: 'session_start',
    ev: { kind: 'session_start', sessionId: 'abc', agent: 'claude', timestamp: NOW },
    line: JSON.stringify({
      kind: 'session_start',
      sessionId: 'abc',
      agent: 'claude',
      timestamp: NOW,
    }),
  },
  {
    name: 'text_delta',
    ev: { kind: 'text_delta', text: 'hello world', timestamp: NOW },
    line: JSON.stringify({ kind: 'text_delta', text: 'hello world', timestamp: NOW }),
  },
  {
    name: 'message',
    ev: { kind: 'message', role: 'assistant', content: 'done', timestamp: NOW },
    line: JSON.stringify({
      kind: 'message',
      role: 'assistant',
      content: 'done',
      timestamp: NOW,
    }),
  },
  {
    name: 'tool_start',
    ev: {
      kind: 'tool_start',
      toolName: 'Read',
      args: { path: '/tmp/x' },
      timestamp: NOW,
    },
    line: JSON.stringify({
      kind: 'tool_start',
      toolName: 'Read',
      args: { path: '/tmp/x' },
      timestamp: NOW,
    }),
  },
  {
    name: 'tool_end',
    ev: {
      kind: 'tool_end',
      toolName: 'Read',
      result: 'file contents',
      durationMs: 42,
      timestamp: NOW,
    },
    line: JSON.stringify({
      kind: 'tool_end',
      toolName: 'Read',
      result: 'file contents',
      durationMs: 42,
      timestamp: NOW,
    }),
  },
  {
    name: 'result',
    ev: {
      kind: 'result',
      exitCode: 0,
      summary: 'all good',
      costUsd: 0.0123,
      terminalReason: 'completed',
      timestamp: NOW,
    },
    line: JSON.stringify({
      kind: 'result',
      exitCode: 0,
      summary: 'all good',
      costUsd: 0.0123,
      terminalReason: 'completed',
      timestamp: NOW,
    }),
  },
  {
    name: 'result-budget',
    ev: {
      kind: 'result',
      exitCode: 0,
      summary: 'budget cap hit',
      costUsd: 0.5,
      terminalReason: 'budget',
      timestamp: NOW,
    },
    line: JSON.stringify({
      kind: 'result',
      exitCode: 0,
      summary: 'budget cap hit',
      costUsd: 0.5,
      terminalReason: 'budget',
      timestamp: NOW,
    }),
  },
  {
    name: 'error',
    ev: {
      kind: 'error',
      errorKind: 'codex_ink_crash',
      message: 'Raw mode is not supported',
      recoverable: true,
      timestamp: NOW,
    },
    line: JSON.stringify({
      kind: 'error',
      errorKind: 'codex_ink_crash',
      message: 'Raw mode is not supported',
      recoverable: true,
      timestamp: NOW,
    }),
  },
  {
    name: 'cancel_requested',
    ev: {
      kind: 'cancel_requested',
      reason: 'user_toggle_off',
      timestamp: NOW,
    },
    line: JSON.stringify({
      kind: 'cancel_requested',
      reason: 'user_toggle_off',
      timestamp: NOW,
    }),
  },
];

describe('CliAgentEvent runtime parsing (L1.T2)', () => {
  describe('round-trip per event kind', () => {
    for (const { name, ev, line } of SAMPLES) {
      it(`${name}: parseEventLine reconstructs the event`, () => {
        const parsed = parseEventLine(line);
        expect(parsed).not.toBeNull();
        expect(parsed).toEqual(ev);
      });

      it(`${name}: parseEventObject accepts the decoded object`, () => {
        const parsed = parseEventObject(JSON.parse(line));
        expect(parsed).toEqual(ev);
      });

      it(`${name}: schema.safeParse round-trips`, () => {
        const result = CliAgentEventSchema.safeParse(JSON.parse(line));
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data).toEqual(ev);
        }
      });
    }

    it('covers all 8 documented event kinds (sanity)', () => {
      const kinds = new Set(SAMPLES.map((s) => s.ev.kind));
      expect(kinds).toEqual(
        new Set([
          'session_start',
          'text_delta',
          'message',
          'tool_start',
          'tool_end',
          'result',
          'error',
          'cancel_requested',
        ]),
      );
    });

    it('result event distinguishes completed vs budget terminal reasons', () => {
      const completed = SAMPLES.find((s) => s.name === 'result')!.ev;
      const budget = SAMPLES.find((s) => s.name === 'result-budget')!.ev;
      expect(completed.kind).toBe('result');
      expect(budget.kind).toBe('result');
      if (completed.kind === 'result' && budget.kind === 'result') {
        expect(completed.terminalReason).toBe('completed');
        expect(budget.terminalReason).toBe('budget');
      }
    });
  });

  describe('parseEventLine — lenient on garbage', () => {
    it('returns null on empty string', () => {
      expect(parseEventLine('')).toBeNull();
    });

    it('returns null on whitespace-only', () => {
      expect(parseEventLine('   \t\n  ')).toBeNull();
    });

    it('returns null on malformed JSON', () => {
      expect(parseEventLine('{not json')).toBeNull();
      expect(parseEventLine('null bytes\x00 here')).toBeNull();
    });

    it('returns null on JSON of wrong shape (number, array, string)', () => {
      expect(parseEventLine('42')).toBeNull();
      expect(parseEventLine('[]')).toBeNull();
      expect(parseEventLine('"raw string"')).toBeNull();
    });

    it('returns null on object missing required field', () => {
      expect(
        parseEventLine(
          JSON.stringify({ kind: 'session_start', sessionId: 'x', agent: 'claude' }),
        ),
      ).toBeNull(); // missing timestamp
      expect(
        parseEventLine(
          JSON.stringify({ kind: 'result', exitCode: 0, summary: 'ok', timestamp: NOW }),
        ),
      ).toBeNull(); // missing costUsd + terminalReason
      expect(
        parseEventLine(
          JSON.stringify({
            kind: 'result',
            exitCode: 0,
            summary: 'ok',
            costUsd: 0.1,
            timestamp: NOW,
          }),
        ),
      ).toBeNull(); // missing terminalReason
      expect(
        parseEventLine(
          JSON.stringify({
            kind: 'result',
            exitCode: 0,
            summary: 'ok',
            costUsd: 0.1,
            terminalReason: 'unknown_reason',
            timestamp: NOW,
          }),
        ),
      ).toBeNull(); // unknown terminalReason value
    });

    it('returns null on object with mistyped field', () => {
      expect(
        parseEventLine(
          JSON.stringify({
            kind: 'session_start',
            sessionId: 'x',
            agent: 'claude',
            timestamp: 'not a number',
          }),
        ),
      ).toBeNull();
      expect(
        parseEventLine(
          JSON.stringify({
            kind: 'tool_end',
            toolName: 'X',
            result: 'r',
            durationMs: -5,
            timestamp: NOW,
          }),
        ),
      ).toBeNull(); // negative durationMs
    });

    it('returns null on unknown kind discriminator', () => {
      expect(
        parseEventLine(
          JSON.stringify({ kind: 'mystery_event', timestamp: NOW }),
        ),
      ).toBeNull();
    });

    it('returns null on unknown agent name in session_start', () => {
      expect(
        parseEventLine(
          JSON.stringify({
            kind: 'session_start',
            sessionId: 'x',
            agent: 'unknown-agent',
            timestamp: NOW,
          }),
        ),
      ).toBeNull();
    });

    it('does NOT throw on any input', () => {
      // Stress sample of pathological inputs.
      const inputs = [
        '',
        ' ',
        '{',
        '}',
        'undefined',
        '[1,2,3]',
        '"' + 'x'.repeat(10_000) + '"',
        JSON.stringify({ kind: 42 }),
        JSON.stringify({ noKind: true }),
      ];
      for (const inp of inputs) {
        expect(() => parseEventLine(inp)).not.toThrow();
      }
    });
  });

  describe('forward-compat — unknown extra fields stripped', () => {
    it('parses session_start with extra fields ignored', () => {
      const parsed = parseEventLine(
        JSON.stringify({
          kind: 'session_start',
          sessionId: 'abc',
          agent: 'claude',
          timestamp: NOW,
          futureField: 'some value',
          modelInfo: { v: 2 },
        }),
      );
      expect(parsed).toEqual({
        kind: 'session_start',
        sessionId: 'abc',
        agent: 'claude',
        timestamp: NOW,
      });
      // Extra fields are gone (stripped, not preserved) — lets the
      // adapter trust the typed shape it receives.
      expect((parsed as Record<string, unknown>).futureField).toBeUndefined();
    });

    it('parses result with extra modelUsage field stripped', () => {
      // Real-world: claude --output-format json carries modelUsage
      // alongside cost+exit; we only model cost+exit+summary+terminalReason in v1.
      const parsed = parseEventLine(
        JSON.stringify({
          kind: 'result',
          exitCode: 0,
          summary: 'ok',
          costUsd: 0.05,
          terminalReason: 'completed',
          timestamp: NOW,
          modelUsage: { 'claude-opus-4-7': { inputTokens: 100, outputTokens: 50 } },
        }),
      );
      expect(parsed).toEqual({
        kind: 'result',
        exitCode: 0,
        summary: 'ok',
        costUsd: 0.05,
        terminalReason: 'completed',
        timestamp: NOW,
      });
    });
  });

  describe('parseEventObject — already-decoded variant', () => {
    it('accepts a JS object directly', () => {
      const obj = {
        kind: 'message' as const,
        role: 'assistant' as const,
        content: 'hi',
        timestamp: NOW,
      };
      expect(parseEventObject(obj)).toEqual(obj);
    });

    it('returns null on plain JS garbage (no JSON parse step)', () => {
      expect(parseEventObject(null)).toBeNull();
      expect(parseEventObject(undefined)).toBeNull();
      expect(parseEventObject(42)).toBeNull();
      expect(parseEventObject([])).toBeNull();
      expect(parseEventObject({ kind: 'unknown' })).toBeNull();
    });
  });
});

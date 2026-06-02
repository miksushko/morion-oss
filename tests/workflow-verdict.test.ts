import { describe, expect, it } from 'vitest';
import { parseVerdict } from '../src/core/auto-code/workflows/verdict.ts';

describe('parseVerdict', () => {
  it('parses bare JSON envelope', () => {
    expect(parseVerdict('{"verdict":"approve","reason":"looks good"}')).toEqual({
      verdict: 'approve',
      reason: 'looks good',
    });
  });

  it('parses fenced ```json block', () => {
    const text = `Here is my decision:\n\n\`\`\`json\n{"verdict": "reopen", "reason": "missing tests"}\n\`\`\``;
    expect(parseVerdict(text)).toEqual({ verdict: 'reopen', reason: 'missing tests' });
  });

  it('parses unfenced trailing JSON in narrative text', () => {
    const text = `I reviewed the diff and noticed several issues with the test coverage. Final verdict:\n{"verdict": "escalate", "reason": "ambiguous spec"}`;
    expect(parseVerdict(text)).toEqual({ verdict: 'escalate', reason: 'ambiguous spec' });
  });

  it('picks the LAST JSON block when multiple present', () => {
    const text = `Earlier I thought {"verdict":"reopen","reason":"old"} but on second look {"verdict":"approve","reason":"final"}`;
    expect(parseVerdict(text)).toEqual({ verdict: 'approve', reason: 'final' });
  });

  it('handles braces inside JSON strings', () => {
    const text = `{"verdict": "approve", "reason": "function returns { name: x }"}`;
    expect(parseVerdict(text)).toEqual({
      verdict: 'approve',
      reason: 'function returns { name: x }',
    });
  });

  it('falls back to escalate on unparseable input', () => {
    expect(parseVerdict('I have no idea — this is hard.')).toEqual({
      verdict: 'escalate',
      reason: 'reviewer produced no parseable verdict (unparseable output)',
    });
  });

  it('falls back to escalate on empty / non-string input', () => {
    expect(parseVerdict('')).toEqual({
      verdict: 'escalate',
      reason: 'reviewer produced no parseable verdict (unparseable output)',
    });
    expect(parseVerdict(null as unknown as string)).toEqual({
      verdict: 'escalate',
      reason: 'reviewer produced no parseable verdict (unparseable output)',
    });
  });

  it('rejects unknown verdict values (not in approve/reopen/escalate)', () => {
    const out = parseVerdict('{"verdict": "maybe", "reason": "unsure"}');
    expect(out.verdict).toBe('escalate');
  });

  it('uses empty string when reason field missing', () => {
    expect(parseVerdict('{"verdict":"approve"}')).toEqual({
      verdict: 'approve',
      reason: '',
    });
  });
});

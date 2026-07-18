import { describe, expect, it } from 'vitest';
import {
  collectVerbatimUserReply,
  extractQuestionBlock,
} from '../src/core/auto-code/workflows/human-gate-verbatim.js';

/**
 * Verbatim human_gate helpers — "Mo = router, not narrator" epic.
 * Pure functions that keep the
 * agent's question and the user's reply in their original words.
 */

describe('extractQuestionBlock', () => {
  it('extracts the text after a QUESTION: marker, verbatim', () => {
    const summary = [
      'I looked at the board rendering.',
      'QUESTION: Should the ghost piece use the same color as the active',
      'piece at 30% opacity, or a fixed grey outline? The SRS spec is silent.',
    ].join('\n');
    const q = extractQuestionBlock(summary);
    expect(q).toBe(
      'Should the ghost piece use the same color as the active\npiece at 30% opacity, or a fixed grey outline? The SRS spec is silent.',
    );
  });

  it('matches the LAST marker when the agent restates the question', () => {
    const summary =
      'QUESTION: first draft?\n\n...reasoning...\n\nQUESTION: final — stacked or columnar layout?';
    expect(extractQuestionBlock(summary)).toBe('final — stacked or columnar layout?');
  });

  it('accepts the Q: shorthand and is case-insensitive', () => {
    expect(extractQuestionBlock('q: keep the legacy fallback?')).toBe(
      'keep the legacy fallback?',
    );
    expect(extractQuestionBlock('Question: which?')).toBe('which?');
  });

  it('returns null when no marker present or empty', () => {
    expect(extractQuestionBlock('just a normal summary, no question')).toBeNull();
    expect(extractQuestionBlock('')).toBeNull();
    expect(extractQuestionBlock(null)).toBeNull();
    expect(extractQuestionBlock('QUESTION:   ')).toBeNull();
  });
});

describe('collectVerbatimUserReply', () => {
  it('joins every user message in order, verbatim, skipping assistant turns', () => {
    const history = [
      { role: 'assistant' as const, content: 'The agent paused to ask:' },
      { role: 'assistant' as const, content: 'stacked or columnar?' },
      { role: 'user' as const, content: 'Use a stacked layout.' },
      { role: 'assistant' as const, content: 'Anything else?' },
      { role: 'user' as const, content: 'And keep the legacy fallback for now.' },
    ];
    expect(collectVerbatimUserReply(history)).toBe(
      'Use a stacked layout.\n\nAnd keep the legacy fallback for now.',
    );
  });

  it('trims and drops blank user messages', () => {
    const history = [
      { role: 'user' as const, content: '  ' },
      { role: 'user' as const, content: '  real answer  ' },
    ];
    expect(collectVerbatimUserReply(history)).toBe('real answer');
  });

  it('returns empty string when the user has not spoken', () => {
    expect(
      collectVerbatimUserReply([
        { role: 'assistant', content: 'waiting...' },
      ]),
    ).toBe('');
  });
});

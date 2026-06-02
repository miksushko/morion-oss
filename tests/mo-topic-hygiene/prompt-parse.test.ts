import { describe, it, expect } from 'vitest';
import {
  buildHygieneMessages,
  parseHygieneResponse,
} from '../../src/core/concierge/index.js';

describe('buildHygieneMessages + parseHygieneResponse', () => {
  it('round-trips a happy proposal', () => {
    const msgs = buildHygieneMessages(
      [
        { clusterId: 'a', noteCount: 3, sampleTitles: ['foo', 'bar'], hasUserPin: false },
        { clusterId: 'b', noteCount: 1, sampleTitles: ['baz'], hasUserPin: false },
      ],
      'task management, agile',
      [],
    );
    const sys = msgs[0]!.content as string;
    expect(sys).toContain('topic-hygiene proposer');
    expect(sys).toContain('User-set generic-term blocklist');
    expect(sys).toContain('task management');
    expect(sys).toContain('Output JSON ONLY');

    const user = msgs[1]!.content as string;
    expect(user).toContain('"a"');
    expect(user).toContain('"b"');
    expect(user).toContain('foo');
  });

  it('includes the PRIORITY RULE: generic-name source ALWAYS demote, never merge', () => {
    // Pins the prompt rule that fixed the customer-issues -> stripe
    // false-merge on Coral Demo (proposer was rationalising "all
    // current notes are about Stripe → merge" even though
    // customer-issues is a generic name that should always demote).
    const msgs = buildHygieneMessages(
      [{ clusterId: 'a', noteCount: 1, sampleTitles: [], hasUserPin: false }],
      '',
      [],
    );
    const sys = msgs[0]!.content as string;
    expect(sys).toContain('PRIORITY RULE');
    expect(sys).toContain('NEVER into merges');
    expect(sys).toContain('customer-issues');
  });

  it('flags user-pinned clusters in the panorama list', () => {
    const msgs = buildHygieneMessages(
      [
        { clusterId: 'pinned', noteCount: 2, sampleTitles: ['t'], hasUserPin: true },
      ],
      '',
      [],
    );
    const user = msgs[1]!.content as string;
    expect(user).toContain('USER-PINNED');
  });

  it('parses a clean JSON proposal', () => {
    const raw = JSON.stringify({
      summary: 'Spotted a few obvious typo-merges.',
      merges: [
        { source: 'auto-code-loop', target: 'auto-code', confidence: 0.95, reason: 'morphological variant' },
        { source: 'mo-chat', target: 'mo-chat-loop', confidence: 0.55, reason: 'might be the same' },
      ],
      demotes: [
        { source: 'user-interface', suggested_tag: 'ui', confidence: 0.9, reason: 'generic descriptor' },
      ],
    });
    const out = parseHygieneResponse(raw)!;
    expect(out.summary).toContain('typo-merges');
    expect(out.merges).toHaveLength(2);
    expect(out.merges[0]).toMatchObject({
      source: 'auto-code-loop',
      target: 'auto-code',
      confidence: 0.95,
    });
    expect(out.demotes).toHaveLength(1);
    expect(out.demotes[0]).toMatchObject({
      source: 'user-interface',
      suggestedTag: 'ui',
    });
  });

  it('drops malformed entries (missing fields, source==target)', () => {
    const raw = JSON.stringify({
      summary: '',
      merges: [
        { source: 'a', target: 'a', confidence: 0.9, reason: 'self' },
        { source: '', target: 'b', confidence: 0.9, reason: '' },
        { source: 'c', target: 'd', confidence: 0.7, reason: 'ok' },
      ],
      demotes: [
        { source: '', suggested_tag: 'x', confidence: 0.8, reason: '' },
        { source: 'real', suggested_tag: '', confidence: 0.8, reason: '' },
      ],
    });
    const out = parseHygieneResponse(raw)!;
    expect(out.merges).toHaveLength(1);
    expect(out.merges[0]?.source).toBe('c');
    expect(out.demotes).toHaveLength(0);
  });

  it('strips markdown fences', () => {
    const raw = '```json\n{"summary":"x","merges":[],"demotes":[]}\n```';
    const out = parseHygieneResponse(raw)!;
    expect(out.summary).toBe('x');
  });

  it('returns null on garbage', () => {
    expect(parseHygieneResponse('total nonsense')).toBeNull();
    expect(parseHygieneResponse('')).toBeNull();
  });
});

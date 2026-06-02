import { describe, it, expect } from 'vitest';
import type { ConciergeMessage } from '../src/web/src/lib/api';
import {
  parsePendingTool,
  PENDING_TOOL_MARKER,
} from '../src/web/src/layout/concierge/pendingTool';
import { deriveSessionTitle } from '../src/web/src/layout/concierge/deriveSessionTitle';
import { truncateResult, truncateArgs } from '../src/web/src/layout/concierge/truncate';
import {
  groupMessages,
  extractPreface,
  extractQueryLines,
  QUERY_MARKER,
} from '../src/web/src/layout/concierge/groupMessages';

const mkMsg = (over: Partial<ConciergeMessage>): ConciergeMessage => ({
  id: over.id ?? 'm1',
  sessionId: 's1',
  role: 'assistant',
  content: '',
  toolCallId: null,
  costUsd: 0,
  tokensIn: null,
  tokensOut: null,
  model: null,
  createdAt: 0,
  quickActions: null,
  repliedActionId: null,
  ...over,
});

describe('parsePendingTool', () => {
  it('returns null when prefix missing', () => {
    expect(parsePendingTool('hello')).toBeNull();
  });

  it('parses a well-formed payload', () => {
    const payload = {
      preface: 'Heads up',
      toolCalls: [{ id: 'c1', name: 'notes_delete', argumentsJson: '{}', displayLabel: "note 'X'" }],
      destructiveCallIds: ['c1'],
      model: 'sonnet',
    };
    const parsed = parsePendingTool(`${PENDING_TOOL_MARKER}\n${JSON.stringify(payload)}`);
    expect(parsed).toEqual(payload);
  });

  it('returns null on malformed JSON tail', () => {
    expect(parsePendingTool(`${PENDING_TOOL_MARKER}{not json`)).toBeNull();
  });

  it('returns null when toolCalls is not an array', () => {
    const bad = JSON.stringify({ toolCalls: 'x', destructiveCallIds: [] });
    expect(parsePendingTool(`${PENDING_TOOL_MARKER} ${bad}`)).toBeNull();
  });

  it('returns null when destructiveCallIds missing', () => {
    const bad = JSON.stringify({ toolCalls: [] });
    expect(parsePendingTool(`${PENDING_TOOL_MARKER} ${bad}`)).toBeNull();
  });
});

describe('deriveSessionTitle', () => {
  it('returns the input flat trimmed when short', () => {
    expect(deriveSessionTitle('  hello  world  ')).toBe('hello world');
  });

  it('collapses newlines + whitespace', () => {
    expect(deriveSessionTitle('a\n\nb\tc')).toBe('a b c');
  });

  it('truncates at 60 chars with ellipsis', () => {
    const long = 'a'.repeat(80);
    const title = deriveSessionTitle(long);
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
  });

  it('cuts on word boundary when a late space exists', () => {
    const text = 'word '.repeat(20).trim();
    const title = deriveSessionTitle(text);
    expect(title.endsWith('…')).toBe(true);
    // boundary cut: head before "…" ends on a complete word, not a partial.
    const head = title.slice(0, -1);
    expect(head.endsWith('word')).toBe(true);
    // and no trailing whitespace before the ellipsis
    expect(title).not.toMatch(/\s…$/);
  });

  it('falls back to hard slice when word boundary is too early', () => {
    const text = `${'x'.repeat(45)} ${'y'.repeat(60)}`;
    // last space inside the 60-char slice is at index 45 (<= 40? no, 45>40)
    // construct one where lastSpace <= 40 to force hard slice
    const noEarlyBoundary = `${'x'.repeat(50)}word${'y'.repeat(20)}`;
    expect(deriveSessionTitle(noEarlyBoundary).endsWith('…')).toBe(true);
    expect(deriveSessionTitle(text).endsWith('…')).toBe(true);
  });
});

describe('truncateResult', () => {
  it('passes short strings through', () => {
    expect(truncateResult('short')).toBe('short');
  });

  it('truncates above 1200 chars and reports remainder', () => {
    const s = 'a'.repeat(1500);
    const out = truncateResult(s);
    expect(out.startsWith('a'.repeat(1200))).toBe(true);
    expect(out).toContain('(300 chars truncated)');
  });

  it('does not truncate exactly 1200 chars', () => {
    const s = 'a'.repeat(1200);
    expect(truncateResult(s)).toBe(s);
  });
});

describe('truncateArgs', () => {
  it('returns empty string for empty input', () => {
    expect(truncateArgs('')).toBe('');
  });

  it('passes short json through unchanged', () => {
    expect(truncateArgs('{"a":1}')).toBe('{"a":1}');
  });

  it('truncates above 80 chars with ellipsis', () => {
    const s = '{"a":"' + 'x'.repeat(100) + '"}';
    const out = truncateArgs(s);
    expect(out.length).toBe(81);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('extractPreface', () => {
  it('returns null when marker absent', () => {
    expect(extractPreface('no marker here')).toBeNull();
  });

  it('returns null when marker is at position 0', () => {
    expect(extractPreface(`${QUERY_MARKER} foo)`)).toBeNull();
  });

  it('returns trimmed head before marker', () => {
    expect(extractPreface(`Let me check.\n\n${QUERY_MARKER} foo)`)).toBe('Let me check.');
  });

  it('returns null when head is whitespace only', () => {
    expect(extractPreface(`   \n${QUERY_MARKER} foo)`)).toBeNull();
  });
});

describe('extractQueryLines', () => {
  it('returns [] when marker absent', () => {
    expect(extractQueryLines('plain text')).toEqual([]);
  });

  it('parses "- name(args)" lines after marker', () => {
    const text = `${QUERY_MARKER} stuff)\n- notes_search(query)\n- folders_list()`;
    expect(extractQueryLines(text)).toEqual([
      { name: 'notes_search', args: 'query' },
      { name: 'folders_list', args: '' },
    ]);
  });

  it('strips trailing ellipsis inside args', () => {
    const text = `${QUERY_MARKER} x)\n- mo_search(query: "abc"…)`;
    expect(extractQueryLines(text)).toEqual([
      { name: 'mo_search', args: 'query: "abc"' },
    ]);
  });

  it('falls back to body-as-name when line does not match shape', () => {
    const text = `${QUERY_MARKER} x)\n- weirdtext`;
    expect(extractQueryLines(text)).toEqual([{ name: 'weirdtext', args: '' }]);
  });
});

describe('groupMessages', () => {
  it('returns [] for empty input', () => {
    expect(groupMessages([])).toEqual([]);
  });

  it('passes plain user/assistant messages through', () => {
    const msgs = [
      mkMsg({ id: 'u', role: 'user', content: 'hi' }),
      mkMsg({ id: 'a', role: 'assistant', content: 'hello' }),
    ];
    const items = groupMessages(msgs);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'message', key: 'u' });
    expect(items[1]).toMatchObject({ kind: 'message', key: 'a' });
  });

  it('skips orphan tool rows', () => {
    const msgs = [mkMsg({ id: 't', role: 'tool', content: '{}' })];
    expect(groupMessages(msgs)).toEqual([]);
  });

  it('folds assistant marker + following tool rows into a tool-group', () => {
    const assistant = mkMsg({
      id: 'a',
      role: 'assistant',
      content: `One sec.\n${QUERY_MARKER} stuff)\n- notes_search(q1)\n- folders_list()`,
      createdAt: 100,
    });
    const tool1 = mkMsg({ id: 't1', role: 'tool', content: 'result-1', toolCallId: 'tc1' });
    const tool2 = mkMsg({ id: 't2', role: 'tool', content: 'result-2', toolCallId: 'tc2' });
    const trailing = mkMsg({ id: 'a2', role: 'assistant', content: 'done' });

    const items = groupMessages([assistant, tool1, tool2, trailing]);
    expect(items).toHaveLength(2);
    const group = items[0];
    expect(group.kind).toBe('tool-group');
    if (group.kind !== 'tool-group') throw new Error('unreachable');
    expect(group.preface).toBe('One sec.');
    expect(group.timestamp).toBe(100);
    expect(group.calls).toEqual([
      { id: 'tc1', name: 'notes_search', args: 'q1', result: 'result-1' },
      { id: 'tc2', name: 'folders_list', args: '', result: 'result-2' },
    ]);
    expect(items[1]).toMatchObject({ kind: 'message', key: 'a2' });
  });

  it('synthesises call ids when tool row lacks toolCallId', () => {
    const assistant = mkMsg({
      id: 'a',
      role: 'assistant',
      content: `${QUERY_MARKER} x)\n- notes_search(q)`,
    });
    const tool = mkMsg({ id: 't1', role: 'tool', content: 'r', toolCallId: null });
    const items = groupMessages([assistant, tool]);
    expect(items).toHaveLength(1);
    if (items[0].kind !== 'tool-group') throw new Error('unreachable');
    expect(items[0].calls[0]!.id).toBe('c_1');
  });

  it('emits a placeholder when a query line has no matching tool row', () => {
    const assistant = mkMsg({
      id: 'a',
      role: 'assistant',
      content: `${QUERY_MARKER} x)\n- notes_search(q1)\n- folders_list()`,
    });
    const tool1 = mkMsg({ id: 't1', role: 'tool', content: 'r1', toolCallId: 'tc1' });
    // second tool missing — placeholder expected
    const items = groupMessages([assistant, tool1]);
    if (items[0].kind !== 'tool-group') throw new Error('unreachable');
    expect(items[0].calls).toHaveLength(2);
    expect(items[0].calls[1]).toEqual({ id: 'c_2', name: 'folders_list', args: '', result: '' });
  });
});

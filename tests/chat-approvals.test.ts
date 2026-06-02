import { describe, it, expect } from 'vitest';
import {
  PENDING_TOOL_MARKER,
  formatPendingToolMessage,
  isPendingToolMessage,
  parsePendingToolMessage,
  isMoApprovalRequired,
  deniedToolResult,
} from '../src/core/concierge/chat-approvals.js';

/**
 * Direction V — pure-logic regressions for the chat-side approval
 * sentinel. Codex finding 01KQ1H5MKPBG7DY0730VRRW178.
 */

describe('PENDING_TOOL_MARKER format/parse round-trip', () => {
  it('formats with marker + JSON, parses back identically', () => {
    const payload = {
      preface: 'I need to clean this up.',
      toolCalls: [
        { id: 'call_1', name: 'notes_delete', argumentsJson: '{"id":"abc"}' },
        { id: 'call_2', name: 'notes_search', argumentsJson: '{"q":"x"}' },
      ],
      destructiveCallIds: ['call_1'],
      model: 'gemini',
    };
    const formatted = formatPendingToolMessage(payload);
    expect(formatted.startsWith(PENDING_TOOL_MARKER)).toBe(true);
    const parsed = parsePendingToolMessage(formatted);
    expect(parsed).toEqual(payload);
  });

  it('returns null for non-marker content', () => {
    expect(parsePendingToolMessage('regular assistant reply')).toBeNull();
    expect(parsePendingToolMessage('')).toBeNull();
    expect(isPendingToolMessage('hello')).toBe(false);
  });

  it('returns null for malformed JSON after the marker', () => {
    expect(parsePendingToolMessage(`${PENDING_TOOL_MARKER}\n{not valid`)).toBeNull();
  });

  it('returns null when JSON is valid but missing required arrays', () => {
    expect(
      parsePendingToolMessage(`${PENDING_TOOL_MARKER}\n{"preface":"x"}`),
    ).toBeNull();
    expect(
      parsePendingToolMessage(
        `${PENDING_TOOL_MARKER}\n{"preface":"x","toolCalls":[],"destructiveCallIds":"oops"}`,
      ),
    ).toBeNull();
  });
});

describe('isMoApprovalRequired', () => {
  const registry = [
    { name: 'notes_delete', category: 'delete' },
    { name: 'notes_update', category: 'update' },
    { name: 'notes_search', category: 'read' },
    { name: 'tasks_move', category: 'update' },
    { name: 'folders_delete', category: 'delete' },
    { name: 'tags_delete', category: 'delete' },
    { name: 'notes_delete_comment', category: 'delete' },
    { name: 'notes_create', category: 'create' },
  ];

  it('returns true for category=delete tools', () => {
    expect(isMoApprovalRequired('notes_delete', registry)).toBe(true);
    expect(isMoApprovalRequired('folders_delete', registry)).toBe(true);
    expect(isMoApprovalRequired('tags_delete', registry)).toBe(true);
    expect(isMoApprovalRequired('notes_delete_comment', registry)).toBe(true);
  });

  it('returns false for update / move tools (operator decision 2026-04-25)', () => {
    // Per ticket discussion: notes_update + tasks_move are Mo's job.
    // Audit log + revisions are the safety net. Asking permission for
    // every move kills the workflow.
    expect(isMoApprovalRequired('notes_update', registry)).toBe(false);
    expect(isMoApprovalRequired('tasks_move', registry)).toBe(false);
  });

  it('returns false for read / create / unknown tools', () => {
    expect(isMoApprovalRequired('notes_search', registry)).toBe(false);
    expect(isMoApprovalRequired('notes_create', registry)).toBe(false);
    expect(isMoApprovalRequired('does_not_exist', registry)).toBe(false);
  });
});

describe('deniedToolResult', () => {
  it('produces a user_denied envelope without a reason', () => {
    const res = deniedToolResult(null);
    expect(res).toMatchObject({ error: 'user_denied' });
    expect(typeof res.message).toBe('string');
  });

  it('embeds a non-empty reason in the message', () => {
    const res = deniedToolResult('Wrong target — that one stays.');
    expect((res.message as string)).toContain('Wrong target');
  });

  it('truncates a runaway reason at 500 chars (defence-in-depth)', () => {
    const long = 'x'.repeat(2000);
    const res = deniedToolResult(long);
    const msg = res.message as string;
    // Suffix can vary; just ensure we don't echo back a 2000-char blob.
    expect(msg.length).toBeLessThanOrEqual(600);
  });
});

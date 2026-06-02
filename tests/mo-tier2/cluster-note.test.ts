import { describe, it, expect, beforeEach } from 'vitest';
import {
  ensureClusterNote,
  findClusterNoteId,
} from '../../src/core/concierge/index.js';
import { setup, type Ctx } from '../helpers/mo-tier2-setup.js';

describe('ensureClusterNote / findClusterNoteId', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('creates a single mo:cluster note with the correct title + source on first call', () => {
    const folder = ctx.folders.create('F');
    const result = ensureClusterNote(ctx.handle.db, folder.id, 'kanban-ui');
    expect(result.created).toBe(true);
    const stored = ctx.handle.db
      .prepare<[string], { title: string; source: string; body: string }>(
        'SELECT title, source, body FROM notes WHERE id = ?',
      )
      .get(result.id);
    expect(stored?.title).toBe('mo:cluster:kanban-ui');
    expect(stored?.source).toBe('mo:cluster');
    expect(stored?.body).toContain('# Cluster: kanban-ui');
  });

  it('is idempotent across calls', () => {
    const folder = ctx.folders.create('F');
    const a = ensureClusterNote(ctx.handle.db, folder.id, 'mo-chat-loop');
    const b = ensureClusterNote(ctx.handle.db, folder.id, 'mo-chat-loop');
    expect(a.id).toBe(b.id);
    expect(b.created).toBe(false);
    expect(findClusterNoteId(ctx.handle.db, folder.id, 'mo-chat-loop')).toBe(a.id);
  });

  it('records an audit row with actor=morion-concierge on creation', () => {
    const folder = ctx.folders.create('F');
    const result = ensureClusterNote(ctx.handle.db, folder.id, 'cluster-x');
    const audit = ctx.handle.db
      .prepare<[string], { action: string; actor: string }>(
        'SELECT action, actor FROM audit_log WHERE note_id = ?',
      )
      .get(result.id);
    expect(audit?.action).toBe('create');
    expect(audit?.actor).toBe('morion-concierge');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { setupNotesRepoCtx, type NotesRepoCtx } from '../helpers/notes-repo-setup.js';

describe('NotesRepository — audit_log + coalescing', () => {
  let ctx: NotesRepoCtx;

  beforeEach(() => {
    ctx = setupNotesRepoCtx();
  });

  it('writes audit_log entries', () => {
    const note = ctx.notes.create({ body: 'X', source: 'user' }, 'mcp:claude');
    ctx.notes.update(note.id, { body: 'X2' }, 'mcp:claude');
    ctx.notes.delete(note.id, 'user');

    const rows = ctx.handle.db
      .prepare('SELECT note_id, action, actor FROM audit_log ORDER BY id')
      .all() as { note_id: string; action: string; actor: string }[];

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ note_id: note.id, action: 'create', actor: 'mcp:claude' });
    expect(rows[1]).toMatchObject({ note_id: note.id, action: 'update', actor: 'mcp:claude' });
    expect(rows[2]).toMatchObject({ note_id: note.id, action: 'delete', actor: 'user' });
  });

  it('coalesces consecutive update audit rows by same actor+note within 5min', () => {
    // Direction Q — autosave fires a PATCH per 500ms debounce, which
    // would otherwise burn one audit row per keystroke. Coalesce keeps
    // a single "edit session" row with the latest ts.
    const note = ctx.notes.create({ body: 'start', source: 'user' }, 'user');
    for (let i = 1; i <= 10; i++) {
      ctx.notes.update(note.id, { body: `version ${i}` }, 'user');
    }
    const rows = ctx.handle.db
      .prepare<[string], { action: string }>(
        `SELECT action FROM audit_log WHERE note_id = ? ORDER BY id`,
      )
      .all(note.id);
    expect(rows.map((r) => r.action)).toEqual(['create', 'update']);
  });

  it('does NOT coalesce update rows across different actors', () => {
    const note = ctx.notes.create({ body: 'start', source: 'user' }, 'user');
    ctx.notes.update(note.id, { body: 'from user 1' }, 'user');
    ctx.notes.update(note.id, { body: 'from mcp' }, 'mcp:claude-desktop');
    ctx.notes.update(note.id, { body: 'user again' }, 'user');
    const rows = ctx.handle.db
      .prepare<[string], { action: string; actor: string }>(
        `SELECT action, actor FROM audit_log WHERE note_id = ? ORDER BY id`,
      )
      .all(note.id);
    expect(rows).toHaveLength(4);
    expect(rows[0]!.action).toBe('create');
    expect(rows.slice(1).every((r) => r.action === 'update')).toBe(true);
    expect(rows[3]!.actor).toBe('user');
  });

  it('does NOT coalesce update rows across different notes', () => {
    const a = ctx.notes.create({ body: 'A', source: 'user' }, 'user');
    const b = ctx.notes.create({ body: 'B', source: 'user' }, 'user');
    ctx.notes.update(a.id, { body: 'A2' }, 'user');
    ctx.notes.update(b.id, { body: 'B2' }, 'user');
    ctx.notes.update(a.id, { body: 'A3' }, 'user');
    const updates = ctx.handle.db
      .prepare<[], { note_id: string; action: string }>(
        `SELECT note_id, action FROM audit_log WHERE action = 'update'`,
      )
      .all();
    expect(updates).toHaveLength(2);
    const byNote = new Set(updates.map((r) => r.note_id));
    expect(byNote.size).toBe(2);
    expect(byNote.has(a.id)).toBe(true);
    expect(byNote.has(b.id)).toBe(true);
  });

  it('breaks coalesce when another action intervenes', () => {
    // Typing -> status change -> typing again should produce TWO update
    // rows bookending the status change, not one.
    const note = ctx.notes.create({ body: 'start', source: 'user' }, 'user');
    ctx.notes.update(note.id, { body: 'first edit' }, 'user');
    ctx.handle.db
      .prepare(
        `INSERT INTO audit_log (note_id, action, actor, ts) VALUES (?, 'status_change', 'user', ?)`,
      )
      .run(note.id, Date.now());
    ctx.notes.update(note.id, { body: 'second edit' }, 'user');
    const actions = ctx.handle.db
      .prepare<[string], { action: string }>(
        `SELECT action FROM audit_log WHERE note_id = ? ORDER BY id`,
      )
      .all(note.id)
      .map((r) => r.action);
    expect(actions).toEqual(['create', 'update', 'status_change', 'update']);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { NoteCommentsRepository } from '../src/core/notes/comments-repository.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import {
  CommentActorMismatchError,
  NestedReplyError,
  encodeCommentCursor,
  decodeCommentCursor,
} from '../src/core/notes/comments-types.js';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  comments: NoteCommentsRepository;
  settings: SettingsRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  return {
    handle,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
    comments: new NoteCommentsRepository(handle.db),
    settings: new SettingsRepository(handle.db),
  };
}

describe('NoteCommentsRepository — CRUD', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('creates a comment with actor + body', () => {
    const note = ctx.notes.create({ body: '# A\n\nbody', source: 'user' }, 'user');
    const c = ctx.comments.create(note.id, 'first comment', 'user');
    expect(c).not.toBeNull();
    expect(c!.noteId).toBe(note.id);
    expect(c!.body).toBe('first comment');
    expect(c!.actor).toBe('user');
    expect(c!.parentId).toBeNull();
    expect(c!.updatedAt).toBeNull();
    expect(c!.createdAt).toBeGreaterThan(0);
  });

  it('returns null when the target note does not exist', () => {
    expect(ctx.comments.create('not-a-real-ulid', 'hi', 'user')).toBeNull();
  });

  it('refuses to comment on a soft-deleted note', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    ctx.notes.delete(note.id, 'user');
    expect(ctx.comments.create(note.id, 'hello', 'user')).toBeNull();
  });

  it('stores mcp:<client> actor verbatim', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const c = ctx.comments.create(note.id, 'from agent', 'mcp:claude-desktop');
    expect(c!.actor).toBe('mcp:claude-desktop');
  });
});

describe('NoteCommentsRepository — 1-level replies', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('allows a reply to a top-level comment', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const parent = ctx.comments.create(note.id, 'top', 'user')!;
    const reply = ctx.comments.create(note.id, 're: top', 'user', parent.id);
    expect(reply).not.toBeNull();
    expect(reply!.parentId).toBe(parent.id);
  });

  it('rejects a reply-to-reply with NestedReplyError', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const parent = ctx.comments.create(note.id, 'top', 'user')!;
    const reply = ctx.comments.create(note.id, 're: top', 'user', parent.id)!;
    expect(() => ctx.comments.create(note.id, 're: re', 'user', reply.id)).toThrow(NestedReplyError);
  });

  it('returns null when parentId points to a comment on a different note', () => {
    const noteA = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const noteB = ctx.notes.create({ body: '# B\n\nb', source: 'user' }, 'user');
    const parent = ctx.comments.create(noteA.id, 'on A', 'user')!;
    expect(ctx.comments.create(noteB.id, 'reply from B', 'user', parent.id)).toBeNull();
  });

  it('returns null when parentId does not exist', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    expect(ctx.comments.create(note.id, 'reply', 'user', 'missing-id')).toBeNull();
  });

  it('listByParent returns replies in chronological oldest-first order', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const parent = ctx.comments.create(note.id, 'top', 'user')!;
    const r1 = ctx.comments.create(note.id, 'first reply', 'user', parent.id)!;
    const r2 = ctx.comments.create(note.id, 'second reply', 'user', parent.id)!;
    const replies = ctx.comments.listByParent(parent.id);
    expect(replies.map((r) => r.id)).toEqual([r1.id, r2.id]);
  });
});

describe('NoteCommentsRepository — pagination + ordering', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('list returns newest-first', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    ctx.comments.create(note.id, 'first', 'user');
    ctx.comments.create(note.id, 'second', 'user');
    ctx.comments.create(note.id, 'third', 'user');
    const page = ctx.comments.list(note.id, { limit: 10 });
    expect(page.items.map((c) => c.body)).toEqual(['third', 'second', 'first']);
  });

  it('list paginates via compound (ts, id) cursor', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const a = ctx.comments.create(note.id, 'a', 'user')!;
    const b = ctx.comments.create(note.id, 'b', 'user')!;
    const c = ctx.comments.create(note.id, 'c', 'user')!;
    const d = ctx.comments.create(note.id, 'd', 'user')!;

    const p1 = ctx.comments.list(note.id, { limit: 2 });
    expect(p1.items.map((x) => x.id)).toEqual([d.id, c.id]);
    expect(p1.nextCursor).not.toBeNull();
    expect(p1.nextCursor).toEqual({ ts: c.createdAt, id: c.id });

    const p2 = ctx.comments.list(note.id, { limit: 2, before: p1.nextCursor! });
    expect(p2.items.map((x) => x.id)).toEqual([b.id, a.id]);
    // fewer than limit → explicit no-more signal
    expect(p2.nextCursor).toBeNull();
  });

  it('compound cursor paginates even when all rows share a created_at (same-ms bursts)', () => {
    // Freeze time so all inserts land on the exact same ms — the degenerate
    // case the old single-field cursor couldn't paginate through.
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const fixedNow = Date.now();
    const origNow = Date.now;
    Date.now = () => fixedNow;
    try {
      const a = ctx.comments.create(note.id, 'a', 'user')!;
      const b = ctx.comments.create(note.id, 'b', 'user')!;
      const c = ctx.comments.create(note.id, 'c', 'user')!;
      const d = ctx.comments.create(note.id, 'd', 'user')!;

      const p1 = ctx.comments.list(note.id, { limit: 2 });
      expect(p1.items.map((x) => x.id)).toEqual([d.id, c.id]);
      const p2 = ctx.comments.list(note.id, { limit: 2, before: p1.nextCursor! });
      expect(p2.items.map((x) => x.id)).toEqual([b.id, a.id]);
      expect(p2.nextCursor).toBeNull();
    } finally {
      Date.now = origNow;
    }
  });

  it('nextCursor is null when page undershoots limit', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    ctx.comments.create(note.id, 'only', 'user');
    const page = ctx.comments.list(note.id, { limit: 20 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('monotonic ulid keeps same-ms inserts deterministically ordered', () => {
    // Force two inserts within the same millisecond by mocking Date.now.
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const fixedNow = Date.now();
    const origNow = Date.now;
    try {
      Date.now = () => fixedNow;
      const c1 = ctx.comments.create(note.id, 'one', 'user')!;
      const c2 = ctx.comments.create(note.id, 'two', 'user')!;
      expect(c1.createdAt).toBe(c2.createdAt);
      const page = ctx.comments.list(note.id, { limit: 10 });
      // Newest first → c2 must come before c1 even though their created_at is equal.
      // ulid monotonic makes c2.id > c1.id so ORDER BY id DESC tie-breaks correctly.
      expect(page.items[0]!.id).toBe(c2.id);
      expect(page.items[1]!.id).toBe(c1.id);
    } finally {
      Date.now = origNow;
    }
  });
});

describe('NoteCommentsRepository — count + batched count', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('count returns live comment total including replies', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const top = ctx.comments.create(note.id, 'top', 'user')!;
    ctx.comments.create(note.id, 're', 'user', top.id);
    ctx.comments.create(note.id, 'also top', 'user');
    expect(ctx.comments.count(note.id)).toBe(3);
  });

  it('countForNotes batches into a single query', () => {
    const a = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const b = ctx.notes.create({ body: '# B\n\nb', source: 'user' }, 'user');
    const c = ctx.notes.create({ body: '# C\n\nb', source: 'user' }, 'user');
    ctx.comments.create(a.id, 'one', 'user');
    ctx.comments.create(a.id, 'two', 'user');
    ctx.comments.create(b.id, 'one', 'user');
    const map = ctx.comments.countForNotes([a.id, b.id, c.id]);
    expect(map.get(a.id)).toBe(2);
    expect(map.get(b.id)).toBe(1);
    // Zero-count notes are absent from the map (caller defaults via ?? 0).
    expect(map.get(c.id)).toBeUndefined();
  });

  it('countForNotes on empty input returns empty map', () => {
    expect(ctx.comments.countForNotes([]).size).toBe(0);
  });
});

describe('NoteCommentsRepository — update', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('updates body and stamps updated_at', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const c = ctx.comments.create(note.id, 'original', 'user')!;
    const updated = ctx.comments.update(c.id, 'edited', 'user')!;
    expect(updated.body).toBe('edited');
    expect(updated.updatedAt).not.toBeNull();
    expect(updated.updatedAt).toBeGreaterThanOrEqual(c.createdAt);
  });

  it('throws CommentActorMismatchError on wrong actor', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const c = ctx.comments.create(note.id, 'by user', 'user')!;
    expect(() => ctx.comments.update(c.id, 'hijack', 'mcp:claude-desktop')).toThrow(
      CommentActorMismatchError,
    );
  });

  it('returns null when id does not exist', () => {
    expect(ctx.comments.update('does-not-exist', 'body', 'user')).toBeNull();
  });

  it('preserves actor on update', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const c = ctx.comments.create(note.id, 'mcp hello', 'mcp:cursor')!;
    const updated = ctx.comments.update(c.id, 'mcp hi', 'mcp:cursor')!;
    expect(updated.actor).toBe('mcp:cursor');
  });
});

describe('NoteCommentsRepository — delete + cascade', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('deletes a top-level comment and cascades replies', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const top = ctx.comments.create(note.id, 'top', 'user')!;
    ctx.comments.create(note.id, 're1', 'user', top.id);
    ctx.comments.create(note.id, 're2', 'user', top.id);
    expect(ctx.comments.count(note.id)).toBe(3);

    expect(ctx.comments.delete(top.id, 'user')).toBe(true);
    expect(ctx.comments.count(note.id)).toBe(0);
    expect(ctx.comments.getById(top.id)).toBeNull();
  });

  it('deleting a reply leaves its parent intact', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const top = ctx.comments.create(note.id, 'top', 'user')!;
    const reply = ctx.comments.create(note.id, 're', 'user', top.id)!;
    expect(ctx.comments.delete(reply.id, 'user')).toBe(true);
    expect(ctx.comments.getById(top.id)).not.toBeNull();
    expect(ctx.comments.count(note.id)).toBe(1);
  });

  it('throws CommentActorMismatchError on wrong actor', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const c = ctx.comments.create(note.id, 'by user', 'user')!;
    expect(() => ctx.comments.delete(c.id, 'mcp:claude-desktop')).toThrow(
      CommentActorMismatchError,
    );
    expect(ctx.comments.getById(c.id)).not.toBeNull();
  });

  it('returns false when id does not exist', () => {
    expect(ctx.comments.delete('does-not-exist', 'user')).toBe(false);
  });

  it('cascades via note hard-purge (FK ON DELETE CASCADE)', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const c = ctx.comments.create(note.id, 'one', 'user')!;
    ctx.comments.create(note.id, 'two', 'user', c.id);
    ctx.notes.delete(note.id, 'user'); // soft-delete first
    ctx.notes.purge(note.id, 'user'); // hard-purge → FK cascade
    expect(ctx.comments.getById(c.id)).toBeNull();
    expect(ctx.comments.count(note.id)).toBe(0);
  });

  it('survives note soft-delete (cascade only on hard-purge)', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const c = ctx.comments.create(note.id, 'one', 'user')!;
    ctx.notes.delete(note.id, 'user');
    expect(ctx.comments.getById(c.id)).not.toBeNull();
  });
});

describe('Cursor encode/decode', () => {
  it('round-trips a (ts, id) pair', () => {
    const c = { ts: 1776497094336, id: '01KPFV8ZQKCYW0GJ9WF3YVJAG1' };
    const encoded = encodeCommentCursor(c);
    expect(encoded).toBe('1776497094336.01KPFV8ZQKCYW0GJ9WF3YVJAG1');
    expect(decodeCommentCursor(encoded)).toEqual(c);
  });

  it('decode returns null on malformed input', () => {
    expect(decodeCommentCursor('')).toBeNull();
    expect(decodeCommentCursor('no-dot-here')).toBeNull();
    expect(decodeCommentCursor('.only-id')).toBeNull();
    expect(decodeCommentCursor('123.')).toBeNull();
    expect(decodeCommentCursor('abc.id')).toBeNull();
    expect(decodeCommentCursor('-1.id')).toBeNull();
  });
});

describe('SettingsRepository — comments-related keys', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('getMcpCommentsEditable defaults to true (fresh DB, no row)', () => {
    expect(ctx.settings.getMcpCommentsEditable()).toBe(true);
  });

  it('setMcpCommentsEditable round-trips through SQLite', () => {
    ctx.settings.setMcpCommentsEditable(false);
    expect(ctx.settings.getMcpCommentsEditable()).toBe(false);
    ctx.settings.setMcpCommentsEditable(true);
    expect(ctx.settings.getMcpCommentsEditable()).toBe(true);
  });

  it('getRequireLlmStatusComment defaults to false (opt-in)', () => {
    expect(ctx.settings.getRequireLlmStatusComment()).toBe(false);
  });

  it('setRequireLlmStatusComment round-trips', () => {
    ctx.settings.setRequireLlmStatusComment(true);
    expect(ctx.settings.getRequireLlmStatusComment()).toBe(true);
  });
});

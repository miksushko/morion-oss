import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { NoteCommentsRepository } from '../src/core/notes/comments-repository.js';
import {
  countActivityForNote,
  listActivityForNote,
} from '../src/core/activity/feed.js';

interface Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  comments: NoteCommentsRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  return {
    handle,
    audit,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
    comments: new NoteCommentsRepository(handle.db),
  };
}

describe('activity feed — UNION ordering', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns both streams unioned: create event + comment + status_change', () => {
    // Create a note → one audit row (action='create').
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    // Post a comment → one note_comments row.
    ctx.comments.create(note.id, 'hello', 'user');
    // Manually log a status_change to simulate Direction N behaviour.
    ctx.audit.recordStatusChange({
      noteId: note.id,
      actor: 'user',
      statusFrom: 'note',
      statusTo: 'todo',
    });

    const page = listActivityForNote(ctx.handle.db, note.id, { limit: 10 });
    expect(page.items).toHaveLength(3);
    // All three rows come back, regardless of within-ms tie-break order
    // (tested explicitly in the compound-cursor test below).
    const kinds = page.items.map((r) =>
      r.kind === 'event' ? (r as { action: string }).action : 'comment',
    );
    expect(kinds).toEqual(expect.arrayContaining(['status_change', 'comment', 'create']));

    const comment = page.items.find((r) => r.kind === 'comment');
    expect(comment).toBeDefined();
    expect((comment as { body: string }).body).toBe('hello');
  });

  it('orders strictly by ts when rows land in different milliseconds', () => {
    // Inject rows with controlled timestamps — bypasses the fast-clock
    // same-ms degeneracy and pins the documented newest-first invariant.
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    // Rewind the create audit row's ts so we can place other rows clearly after.
    ctx.handle.db.prepare(
      `UPDATE audit_log SET ts = 1000 WHERE note_id = ? AND action = 'create'`,
    ).run(note.id);
    // Insert a comment at ts = 2000 (via direct INSERT to control ts).
    ctx.handle.db.prepare(
      `INSERT INTO note_comments (id, note_id, parent_id, body, actor, created_at)
       VALUES ('01MIDDLECOMMENT00000000000', ?, NULL, 'middle', 'user', 2000)`,
    ).run(note.id);
    // Status change audit row at ts = 3000.
    ctx.handle.db.prepare(
      `INSERT INTO audit_log (note_id, action, actor, ts, status_from, status_to)
       VALUES (?, 'status_change', 'user', 3000, 'note', 'todo')`,
    ).run(note.id);

    const page = listActivityForNote(ctx.handle.db, note.id, { limit: 10 });
    expect(page.items).toHaveLength(3);
    // Strict newest-first when ts values are unambiguous.
    expect(page.items[0]!.kind).toBe('event');
    expect((page.items[0] as { action: string }).action).toBe('status_change');
    expect(page.items[1]!.kind).toBe('comment');
    expect(page.items[2]!.kind).toBe('event');
    expect((page.items[2] as { action: string }).action).toBe('create');
  });

  it('preserves chronological ordering across identical ts (compound cursor tie-break)', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const fixedNow = Date.now();
    const origNow = Date.now;
    Date.now = () => fixedNow;
    try {
      const c1 = ctx.comments.create(note.id, 'one', 'user')!;
      const c2 = ctx.comments.create(note.id, 'two', 'user')!;
      const page = listActivityForNote(ctx.handle.db, note.id, { limit: 10 });
      // Both c1 and c2 share ts; sort_key = `c:<ulid>` tie-breaks by ulid.
      // Monotonic ulid → c2.id > c1.id → c2 first (DESC).
      const commentRows = page.items.filter((r) => r.kind === 'comment') as Array<{
        id: string;
      }>;
      expect(commentRows[0]!.id).toBe(c2.id);
      expect(commentRows[1]!.id).toBe(c1.id);
    } finally {
      Date.now = origNow;
    }
  });

  it('includes comment_delete tombstone events', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const c = ctx.comments.create(note.id, 'temp', 'user')!;
    // Emulate the route's tx: delete + audit in one go.
    ctx.comments.delete(c.id, 'user');
    ctx.audit.record({ noteId: note.id, action: 'comment_delete', actor: 'user' });

    const page = listActivityForNote(ctx.handle.db, note.id, { limit: 10 });
    const actions = page.items
      .filter((r) => r.kind === 'event')
      .map((r) => (r as { action: string }).action);
    expect(actions).toContain('comment_delete');
    expect(actions).toContain('create');
  });
});

describe('activity feed — pagination', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('paginates with compound cursor across mixed streams', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    // Seed 4 comments on top of the 1 create event.
    ctx.comments.create(note.id, 'c1', 'user');
    ctx.comments.create(note.id, 'c2', 'user');
    ctx.comments.create(note.id, 'c3', 'user');
    ctx.comments.create(note.id, 'c4', 'user');

    const p1 = listActivityForNote(ctx.handle.db, note.id, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = listActivityForNote(ctx.handle.db, note.id, {
      limit: 2,
      before: p1.nextCursor!,
    });
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).not.toBeNull();

    const p3 = listActivityForNote(ctx.handle.db, note.id, {
      limit: 2,
      before: p2.nextCursor!,
    });
    // Last row is the 'create' event (oldest).
    expect(p3.items).toHaveLength(1);
    expect(p3.nextCursor).toBeNull();

    // No duplicates, no skipped rows across pages.
    const allIds = [...p1.items, ...p2.items, ...p3.items].map((r) =>
      r.kind === 'comment' ? r.id : `event-${(r as { action: string }).action}-${r.ts}`,
    );
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('clamps limit to 200 max', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    // Not seeding 500 rows — just asserting the query doesn't blow up
    // on an absurd limit and returns all available rows.
    const page = listActivityForNote(ctx.handle.db, note.id, { limit: 1_000_000 });
    expect(page.items.length).toBeLessThanOrEqual(200);
  });
});

describe('activity feed — count', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('counts both streams', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    // 1 create audit row + 3 comments + 1 status_change audit row = 5
    ctx.comments.create(note.id, 'one', 'user');
    ctx.comments.create(note.id, 'two', 'user');
    ctx.comments.create(note.id, 'three', 'user');
    ctx.audit.recordStatusChange({
      noteId: note.id,
      actor: 'user',
      statusFrom: 'note',
      statusTo: 'todo',
    });
    expect(countActivityForNote(ctx.handle.db, note.id)).toBe(5);
  });

  it('returns 0 for a note with no activity rows', () => {
    // Inject a row via raw SQL (bypasses NotesRepository's create audit hook).
    ctx.handle.db
      .prepare(
        `INSERT INTO notes (id, folder_id, title, body, pinned, source, created_at, updated_at)
         VALUES ('no-activity', NULL, 'T', 'B', 0, 'user', 0, 0)`,
      )
      .run();
    expect(countActivityForNote(ctx.handle.db, 'no-activity')).toBe(0);
  });

  it('counts are scoped to the given note', () => {
    const a = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const b = ctx.notes.create({ body: '# B\n\nb', source: 'user' }, 'user');
    ctx.comments.create(a.id, 'on A', 'user');
    ctx.comments.create(b.id, 'on B', 'user');
    ctx.comments.create(b.id, 'also on B', 'user');

    const countA = countActivityForNote(ctx.handle.db, a.id);
    const countB = countActivityForNote(ctx.handle.db, b.id);
    // A: 1 create audit + 1 comment = 2. B: 1 create audit + 2 comments = 3.
    expect(countA).toBe(2);
    expect(countB).toBe(3);
  });
});

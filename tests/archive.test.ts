import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import {
  isNoteMcpHidden,
  isFolderMcpHidden,
  filterArchivedFromMcp,
} from '../src/core/archive/check.js';

/**
 * Ticket 01KPGNY92RPYA4AEPC32C9HH0P — archive support for notes and
 * folders. Pins the core invariants:
 *
 *  1. Archived notes are hidden from `list()` / `recent()` by default
 *     but visible when `includeArchived:true`.
 *  2. Archived folders hide both themselves and their child notes from
 *     default lists — even if the note has no individual
 *     `archivedAt`.
 *  3. MCP gate (`isNoteMcpHidden` / `isFolderMcpHidden`) treats archive
 *     as "not accessible", distinct from the Pro permission ACCESS_DENIED
 *     path.
 *  4. Unarchive restores visibility without touching per-note archive
 *     state (folder archive doesn't cascade onto notes).
 */

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  return {
    handle,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
  };
}

describe('archive — notes repository', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('archive() sets archivedAt timestamp and hides from default list', () => {
    const n = ctx.notes.create({ body: '# Hello', source: 'user' }, 'user');
    expect(n.archivedAt).toBeNull();

    expect(ctx.notes.archive(n.id, 'user')).toBe(true);
    const refetched = ctx.notes.getById(n.id);
    expect(refetched?.archivedAt).toBeGreaterThan(0);

    // Default list hides archived notes.
    const visible = ctx.notes.list({ limit: 50, offset: 0 });
    expect(visible.map((x) => x.id)).not.toContain(n.id);

    // Opt-in surfaces them.
    const withArchived = ctx.notes.list({ limit: 50, offset: 0, includeArchived: true });
    expect(withArchived.map((x) => x.id)).toContain(n.id);
  });

  it('archive() is idempotent — second call returns false', () => {
    const n = ctx.notes.create({ body: 'A', source: 'user' }, 'user');
    expect(ctx.notes.archive(n.id, 'user')).toBe(true);
    expect(ctx.notes.archive(n.id, 'user')).toBe(false);
  });

  it('unarchive() clears archivedAt and restores visibility', () => {
    const n = ctx.notes.create({ body: 'B', source: 'user' }, 'user');
    ctx.notes.archive(n.id, 'user');
    expect(ctx.notes.unarchive(n.id, 'user')).toBe(true);
    expect(ctx.notes.getById(n.id)?.archivedAt).toBeNull();

    const visible = ctx.notes.list({ limit: 50, offset: 0 });
    expect(visible.map((x) => x.id)).toContain(n.id);
  });

  it('recent() also filters archived by default', () => {
    const n = ctx.notes.create({ body: 'R', source: 'user' }, 'user');
    ctx.notes.archive(n.id, 'user');
    expect(ctx.notes.recent(50).map((x) => x.id)).not.toContain(n.id);
    expect(ctx.notes.recent(50, { includeArchived: true }).map((x) => x.id)).toContain(n.id);
  });

  it('list() drops notes whose folder is archived even if the note itself is not', () => {
    const folder = ctx.folders.create('Project X');
    const n = ctx.notes.create(
      { body: 'Inside archived folder', folderId: folder.id, source: 'user' },
      'user',
    );
    expect(ctx.notes.list({ limit: 50, offset: 0 }).map((x) => x.id)).toContain(n.id);

    ctx.folders.setArchived(folder.id, true);
    expect(ctx.notes.list({ limit: 50, offset: 0 }).map((x) => x.id)).not.toContain(n.id);

    // Unfiled notes still show up (the LEFT JOIN preserves them).
    const u = ctx.notes.create({ body: 'unfiled', source: 'user' }, 'user');
    expect(ctx.notes.list({ limit: 50, offset: 0 }).map((x) => x.id)).toContain(u.id);
  });

  it('archive() records an audit row', () => {
    const n = ctx.notes.create({ body: 'A', source: 'user' }, 'user');
    ctx.notes.archive(n.id, 'user');
    const rows = ctx.handle.db
      .prepare('SELECT action FROM audit_log WHERE note_id = ? ORDER BY ts')
      .all(n.id) as Array<{ action: string }>;
    expect(rows.map((r) => r.action)).toContain('archive');
  });
});

describe('archive — folders repository', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('setArchived(true) hides folder from default list', () => {
    const f = ctx.folders.create('Docs');
    expect(f.archivedAt).toBeNull();

    ctx.folders.setArchived(f.id, true);
    expect(ctx.folders.list().map((x) => x.id)).not.toContain(f.id);
    expect(ctx.folders.list({ includeArchived: true }).map((x) => x.id)).toContain(f.id);

    // getById still returns the folder so the UI can render it with a
    // badge / offer unarchive.
    expect(ctx.folders.getById(f.id)?.archivedAt).toBeGreaterThan(0);
  });

  it('setArchived(false) restores a previously-archived folder', () => {
    const f = ctx.folders.create('Docs');
    ctx.folders.setArchived(f.id, true);
    ctx.folders.setArchived(f.id, false);
    expect(ctx.folders.getById(f.id)?.archivedAt).toBeNull();
    expect(ctx.folders.list().map((x) => x.id)).toContain(f.id);
  });

  it('folder archive does NOT cascade onto per-note archivedAt — unarchive restores prior state', () => {
    const f = ctx.folders.create('Mix');
    const n1 = ctx.notes.create({ body: 'A', folderId: f.id, source: 'user' }, 'user');
    const n2 = ctx.notes.create({ body: 'B', folderId: f.id, source: 'user' }, 'user');
    ctx.notes.archive(n2.id, 'user'); // individually archived

    ctx.folders.setArchived(f.id, true);
    // With folder hidden, BOTH notes invisible via default list...
    expect(ctx.notes.list({ limit: 50, offset: 0 }).map((x) => x.id)).not.toContain(n1.id);
    expect(ctx.notes.list({ limit: 50, offset: 0 }).map((x) => x.id)).not.toContain(n2.id);

    // ...but their individual flags untouched.
    expect(ctx.notes.getById(n1.id)?.archivedAt).toBeNull();
    expect(ctx.notes.getById(n2.id)?.archivedAt).toBeGreaterThan(0);

    // Unarchive folder: n1 returns to default list, n2 stays hidden
    // (it's still individually archived — exact prior state preserved).
    ctx.folders.setArchived(f.id, false);
    expect(ctx.notes.list({ limit: 50, offset: 0 }).map((x) => x.id)).toContain(n1.id);
    expect(ctx.notes.list({ limit: 50, offset: 0 }).map((x) => x.id)).not.toContain(n2.id);
  });
});

describe('archive — MCP hidden helpers', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('isNoteMcpHidden is true for archived note', () => {
    const n = ctx.notes.create({ body: 'A', source: 'user' }, 'user');
    expect(isNoteMcpHidden(n, ctx)).toBe(false);
    ctx.notes.archive(n.id, 'user');
    const archived = ctx.notes.getById(n.id)!;
    expect(isNoteMcpHidden(archived, ctx)).toBe(true);
  });

  it('isNoteMcpHidden is true when the containing folder is archived', () => {
    const f = ctx.folders.create('Hidden');
    const n = ctx.notes.create({ body: 'A', folderId: f.id, source: 'user' }, 'user');
    expect(isNoteMcpHidden(n, ctx)).toBe(false);
    ctx.folders.setArchived(f.id, true);
    expect(isNoteMcpHidden(n, ctx)).toBe(true);
  });

  it('isFolderMcpHidden reflects archivedAt', () => {
    const f = ctx.folders.create('X');
    expect(isFolderMcpHidden(f)).toBe(false);
    ctx.folders.setArchived(f.id, true);
    const archived = ctx.folders.getById(f.id)!;
    expect(isFolderMcpHidden(archived)).toBe(true);
  });

  it('filterArchivedFromMcp drops both individually-archived and folder-archived notes', () => {
    const fActive = ctx.folders.create('Active');
    const fHidden = ctx.folders.create('Hidden');
    const n1 = ctx.notes.create({ body: '1', folderId: fActive.id, source: 'user' }, 'user');
    const n2 = ctx.notes.create({ body: '2', folderId: fActive.id, source: 'user' }, 'user');
    const n3 = ctx.notes.create({ body: '3', folderId: fHidden.id, source: 'user' }, 'user');
    ctx.notes.archive(n2.id, 'user');
    ctx.folders.setArchived(fHidden.id, true);

    const all = [
      ctx.notes.getById(n1.id)!,
      ctx.notes.getById(n2.id)!,
      ctx.notes.getById(n3.id)!,
    ];
    const visible = filterArchivedFromMcp(all, ctx);
    expect(visible.map((n) => n.id)).toEqual([n1.id]);
  });
});

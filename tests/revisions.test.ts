import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import {
  RevisionsRepository,
  BASELINE_THRESHOLD_MS,
} from '../src/core/revisions/repository.js';

interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  tags: TagsRepository;
  revisions: RevisionsRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  return {
    handle,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
    tags: new TagsRepository(handle.db),
    revisions: new RevisionsRepository(handle.db),
  };
}

/**
 * Helper: pretend a revision was written `ageMs` ago by rewinding its
 * `created_at` directly. The repository normally stamps `Date.now()` at
 * insert time and the test infra is too fast to produce naturally aged
 * rows.
 */
function ageRevision(ctx: Ctx, revisionId: string, ageMs: number): void {
  ctx.handle.db
    .prepare('UPDATE note_revisions SET created_at = ? WHERE id = ?')
    .run(Date.now() - ageMs, revisionId);
}

describe('RevisionsRepository', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('snapshots the live note state into a new revision', () => {
    const note = ctx.notes.create({ body: '# A\n\nfirst body', source: 'user' }, 'user');
    const rev = ctx.revisions.create(note.id, 'user');
    expect(rev).not.toBeNull();
    expect(rev!.title).toBe('A');
    expect(rev!.body).toBe('# A\n\nfirst body');
    expect(rev!.actor).toBe('user');
    expect(rev!.tagIds).toEqual([]);
    expect(rev!.folderId).toBeNull();
    expect(rev!.kind).toBe('recent');
  });

  it('returns null when the note id does not exist', () => {
    expect(ctx.revisions.create('not-a-real-id', 'user')).toBeNull();
  });

  it('refuses to snapshot a soft-deleted note', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    ctx.notes.delete(note.id, 'user');
    expect(ctx.revisions.create(note.id, 'user')).toBeNull();
  });

  it('dedupes byte-identical consecutive snapshots', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const first = ctx.revisions.create(note.id, 'user');
    const second = ctx.revisions.create(note.id, 'user');
    expect(first!.id).toBe(second!.id);
    expect(ctx.revisions.listForNote(note.id)).toHaveLength(1);
  });

  it('treats a tag set change as a new snapshot', () => {
    const note = ctx.notes.create(
      { body: '# A\n\nb', tags: ['one'], source: 'user' },
      'user',
    );
    ctx.revisions.create(note.id, 'user');
    ctx.notes.update(note.id, { tags: ['one', 'two'] }, 'user');
    ctx.revisions.create(note.id, 'user');
    expect(ctx.revisions.listForNote(note.id)).toHaveLength(2);
  });

  it('treats a folder move as a new snapshot', () => {
    const folder = ctx.folders.create('Work');
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    ctx.revisions.create(note.id, 'user');
    ctx.notes.update(note.id, { folderId: folder.id }, 'user');
    ctx.revisions.create(note.id, 'user');
    const list = ctx.revisions.listForNote(note.id);
    expect(list).toHaveLength(2);
    expect(list[0]!.folderId).toBe(folder.id);
    expect(list[1]!.folderId).toBeNull();
  });

  it('keeps only the three newest recents and prunes the rest', () => {
    const note = ctx.notes.create({ body: '# A\n\nb0', source: 'user' }, 'user');
    for (let i = 1; i <= 5; i++) {
      ctx.notes.update(note.id, { body: `# A\n\nb${i}` }, 'user');
      ctx.revisions.create(note.id, 'user');
    }
    const list = ctx.revisions.listForNote(note.id);
    // 5 distinct snapshots -> trimmed to 3 newest because none are baseline-aged.
    expect(list).toHaveLength(3);
    expect(list.map((r) => r.body)).toEqual(['# A\n\nb5', '# A\n\nb4', '# A\n\nb3']);
    expect(list.every((r) => r.kind === 'recent')).toBe(true);
  });

  it('keeps a baseline slot once a revision ages past the threshold', () => {
    const note = ctx.notes.create({ body: '# A\n\nb0', source: 'user' }, 'user');
    const rev0 = ctx.revisions.create(note.id, 'user')!;
    // Pretend the first snapshot is 5 hours old -> it qualifies as baseline.
    ageRevision(ctx, rev0.id, BASELINE_THRESHOLD_MS + 60_000);

    for (let i = 1; i <= 4; i++) {
      ctx.notes.update(note.id, { body: `# A\n\nb${i}` }, 'user');
      ctx.revisions.create(note.id, 'user');
    }

    const list = ctx.revisions.listForNote(note.id);
    expect(list).toHaveLength(4);
    const baselines = list.filter((r) => r.kind === 'baseline');
    expect(baselines).toHaveLength(1);
    expect(baselines[0]!.id).toBe(rev0.id);
    expect(baselines[0]!.body).toBe('# A\n\nb0');
    const recents = list.filter((r) => r.kind === 'recent');
    expect(recents.map((r) => r.body)).toEqual(['# A\n\nb4', '# A\n\nb3', '# A\n\nb2']);
  });

  it('refreshes the baseline as the previous one ages even further', () => {
    const note = ctx.notes.create({ body: '# A\n\nb0', source: 'user' }, 'user');
    // Two old revisions, both baseline-eligible. The newer of the two should
    // win the baseline slot; the older one should be pruned.
    const rev0 = ctx.revisions.create(note.id, 'user')!;
    ctx.notes.update(note.id, { body: '# A\n\nb1' }, 'user');
    const rev1 = ctx.revisions.create(note.id, 'user')!;
    ageRevision(ctx, rev0.id, BASELINE_THRESHOLD_MS * 2);
    ageRevision(ctx, rev1.id, BASELINE_THRESHOLD_MS + 60_000);

    // Then 3 fresh recents.
    for (let i = 2; i <= 4; i++) {
      ctx.notes.update(note.id, { body: `# A\n\nb${i}` }, 'user');
      ctx.revisions.create(note.id, 'user');
    }

    const list = ctx.revisions.listForNote(note.id);
    expect(list).toHaveLength(4);
    const baselines = list.filter((r) => r.kind === 'baseline');
    expect(baselines).toHaveLength(1);
    expect(baselines[0]!.id).toBe(rev1.id);
    // rev0 should have been dropped during pruning.
    expect(list.find((r) => r.id === rev0.id)).toBeUndefined();
  });

  it('cascades on hard purge', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    ctx.revisions.create(note.id, 'user');
    ctx.notes.delete(note.id, 'user');
    expect(ctx.notes.purge(note.id, 'user')).toBe(true);
    expect(ctx.revisions.listForNote(note.id)).toEqual([]);
  });

  it('survives soft-delete + restore', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const rev = ctx.revisions.create(note.id, 'user')!;
    ctx.notes.delete(note.id, 'user');
    // Trash mode: revisions stay in the table even though the note is hidden.
    const row = ctx.handle.db
      .prepare('SELECT id FROM note_revisions WHERE id = ?')
      .get(rev.id);
    expect(row).toBeTruthy();
    ctx.notes.restore(note.id, 'user');
    expect(ctx.revisions.listForNote(note.id)).toHaveLength(1);
  });

  it('looks up revisions by id', () => {
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const rev = ctx.revisions.create(note.id, 'user')!;
    const fetched = ctx.revisions.getById(rev.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(rev.id);
    expect(fetched!.body).toBe('# A\n\nb');
  });

  it('stores tag ids, not tag names, so renames keep history correct', () => {
    const note = ctx.notes.create(
      { body: '# A\n\nb', tags: ['original'], source: 'user' },
      'user',
    );
    const rev = ctx.revisions.create(note.id, 'user')!;
    expect(rev.tagIds).toHaveLength(1);
    const tagId = rev.tagIds[0]!;
    const tagRow = ctx.handle.db
      .prepare<[string], { name: string }>('SELECT name FROM tags WHERE id = ?')
      .get(tagId);
    expect(tagRow!.name).toBe('original');
  });

  /**
   * Audit finding N20, 2026-04-16. Revision dedup used to compare
   * body bytes verbatim. A Windows-clipboard paste that round-tripped
   * \r\n, or an editor that trimmed trailing spaces, would count as
   * a "new" revision even though the user didn't actually change the
   * content — chewing through the 4-slot retention budget and
   * evicting real earlier snapshots. Now bodies are normalised
   * (CRLF → LF, trailing-space-before-\n → \n, trailing \n stripped)
   * BEFORE the comparison, but stored bytes stay untouched.
   */
  it('dedupes body bytes that differ only in CRLF / trailing whitespace', () => {
    const note = ctx.notes.create(
      { body: '# Task\n\nbody line', source: 'user' },
      'user',
    );
    const first = ctx.revisions.create(note.id, 'user')!;

    // Flip body to CRLF + trailing spaces + trailing newline. No
    // visible content change; the editor just happened to reformat.
    ctx.notes.update(note.id, { body: '# Task\r\n\r\nbody line   \r\n' }, 'user');
    const second = ctx.revisions.create(note.id, 'user');

    // Dedup hit — same logical content.
    expect(second!.id).toBe(first.id);
    expect(ctx.revisions.listForNote(note.id)).toHaveLength(1);
  });

  it('does NOT dedup when only the tag set changes', () => {
    // Tags are compared via the JSON array. A real tag diff has to
    // create a new revision even if body is identical.
    const note = ctx.notes.create(
      { body: 'same body', tags: ['a'], source: 'user' },
      'user',
    );
    const first = ctx.revisions.create(note.id, 'user')!;
    ctx.notes.update(note.id, { tags: ['a', 'b'] }, 'user');
    const second = ctx.revisions.create(note.id, 'user')!;
    expect(second.id).not.toBe(first.id);
  });
});

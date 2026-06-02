import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import {
  runTier0Checks,
  findStuckTickets,
  findUntaggedNotes,
  findShortBodies,
  findBrokenTitles,
} from '../src/core/concierge/index.js';

/**
 * Mo Indexing Redesign Phase 1 — Tier 0 deterministic checkers.
 * Pure SQL contracts, zero LLM. Folder filter, kind/severity, message
 * format, and false-positive guards.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  tags: TagsRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  return {
    handle,
    audit,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
    tags: new TagsRepository(handle.db),
  };
}

describe('findStuckTickets', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('flags doing-tickets older than threshold; ignores fresh ones', () => {
    const folder = ctx.folders.create('F');
    const now = 100 * DAY_MS;

    const stale = ctx.notes.create(
      { body: '# Stuck', folderId: folder.id, source: 'user', status: 'doing' },
      'user',
    );
    // 20 days — past the 14-day P2 threshold but under the 30-day P1
    // escalation. Rewind updated_at directly — the repository auto-stamps now.
    ctx.handle.db
      .prepare('UPDATE notes SET updated_at = ? WHERE id = ?')
      .run(now - 20 * DAY_MS, stale.id);

    const fresh = ctx.notes.create(
      { body: '# Fresh', folderId: folder.id, source: 'user', status: 'doing' },
      'user',
    );
    ctx.handle.db
      .prepare('UPDATE notes SET updated_at = ? WHERE id = ?')
      .run(now - 2 * DAY_MS, fresh.id);

    const findings = findStuckTickets(ctx.handle.db, folder.id, {
      stuckDoingDays: 14,
      now,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('stuck_doing');
    expect(findings[0]!.noteId).toBe(stale.id);
    expect(findings[0]!.severity).toBe('p2');
    expect(findings[0]!.context.ageDays).toBe(20);
  });

  it('escalates 30+ day doing to P1', () => {
    const folder = ctx.folders.create('F');
    const now = 100 * DAY_MS;
    const note = ctx.notes.create(
      { body: '# Stuck', folderId: folder.id, source: 'user', status: 'doing' },
      'user',
    );
    ctx.handle.db
      .prepare('UPDATE notes SET updated_at = ? WHERE id = ?')
      .run(now - 35 * DAY_MS, note.id);

    const findings = findStuckTickets(ctx.handle.db, folder.id, {
      stuckDoingDays: 14,
      now,
    });
    expect(findings[0]!.severity).toBe('p1');
  });

  it('separately handles review threshold', () => {
    const folder = ctx.folders.create('F');
    const now = 100 * DAY_MS;
    const note = ctx.notes.create(
      { body: '# In review', folderId: folder.id, source: 'user', status: 'review' },
      'user',
    );
    ctx.handle.db
      .prepare('UPDATE notes SET updated_at = ? WHERE id = ?')
      .run(now - 10 * DAY_MS, note.id);

    const findings = findStuckTickets(ctx.handle.db, folder.id, {
      stuckReviewDays: 7,
      now,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('stuck_review');
  });

  it('skips deleted and archived notes', () => {
    const folder = ctx.folders.create('F');
    const now = 100 * DAY_MS;
    const a = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user', status: 'doing' },
      'user',
    );
    const b = ctx.notes.create(
      { body: '# B', folderId: folder.id, source: 'user', status: 'doing' },
      'user',
    );
    ctx.handle.db
      .prepare(`UPDATE notes SET updated_at = ?, deleted_at = ? WHERE id = ?`)
      .run(now - 30 * DAY_MS, now - 1 * DAY_MS, a.id);
    ctx.handle.db
      .prepare(`UPDATE notes SET updated_at = ?, archived_at = ? WHERE id = ?`)
      .run(now - 30 * DAY_MS, now - 1 * DAY_MS, b.id);

    const findings = findStuckTickets(ctx.handle.db, folder.id, {
      stuckDoingDays: 14,
      now,
    });
    expect(findings).toHaveLength(0);
  });

  it('only sees the requested folder', () => {
    const f1 = ctx.folders.create('F1');
    const f2 = ctx.folders.create('F2');
    const now = 100 * DAY_MS;
    const inF1 = ctx.notes.create(
      { body: '# A', folderId: f1.id, source: 'user', status: 'doing' },
      'user',
    );
    const inF2 = ctx.notes.create(
      { body: '# B', folderId: f2.id, source: 'user', status: 'doing' },
      'user',
    );
    ctx.handle.db
      .prepare('UPDATE notes SET updated_at = ? WHERE id IN (?, ?)')
      .run(now - 30 * DAY_MS, inF1.id, inF2.id);

    const f1Findings = findStuckTickets(ctx.handle.db, f1.id, { now });
    expect(f1Findings.map((f) => f.noteId)).toEqual([inF1.id]);
  });
});

describe('findUntaggedNotes', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('reports notes with no tags but skips trivially short ones', () => {
    const folder = ctx.folders.create('F');
    const tagged = ctx.notes.create(
      {
        body: '# Tagged ticket\n\nA real ticket with content\n\nMore content\n\n',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    ctx.notes.update(
      tagged.id,
      {
        tags: ['lesson'],
      },
      'user',
    );
    const untagged = ctx.notes.create(
      {
        body:
          '# Untagged\n\nA full ticket without tags. Long enough to clear ' +
          'the short_body filter so we focus on tagging.',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    const stub = ctx.notes.create(
      { body: '# stub', folderId: folder.id, source: 'user' },
      'user',
    );
    void stub;

    const findings = findUntaggedNotes(ctx.handle.db, folder.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.noteId).toBe(untagged.id);
    expect(findings[0]!.kind).toBe('no_tags');
  });
});

describe('findShortBodies', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('flags bodies under threshold', () => {
    const folder = ctx.folders.create('F');
    const stub = ctx.notes.create(
      { body: '# tiny', folderId: folder.id, source: 'user' },
      'user',
    );
    const ok = ctx.notes.create(
      {
        body:
          '# Real body\n\nThis ticket is wholly described and should not ' +
          'show up as a stub.',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    void ok;

    const findings = findShortBodies(ctx.handle.db, folder.id, { minBodyChars: 50 });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.noteId).toBe(stub.id);
    expect(findings[0]!.kind).toBe('short_body');
  });
});

describe('findBrokenTitles', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('flags strikethrough first lines', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      {
        body: '~~Original idea now scrapped~~\n\nNew direction described below.',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    const findings = findBrokenTitles(ctx.handle.db, folder.id);
    const strike = findings.find((f) => f.kind === 'broken_title_strikethrough');
    expect(strike).toBeDefined();
    expect(strike!.noteId).toBe(note.id);
  });

  it('flags overlong first lines', () => {
    const folder = ctx.folders.create('F');
    const longLine = 'A '.repeat(150);
    const note = ctx.notes.create(
      { body: longLine, folderId: folder.id, source: 'user' },
      'user',
    );
    const findings = findBrokenTitles(ctx.handle.db, folder.id, {
      maxTitleLineChars: 200,
    });
    const overlong = findings.find((f) => f.kind === 'broken_title_overlong');
    expect(overlong).toBeDefined();
    expect(overlong!.noteId).toBe(note.id);
  });
});

describe('runTier0Checks — orchestrator', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('runs every check and concatenates findings', () => {
    const folder = ctx.folders.create('F');
    const now = 100 * DAY_MS;
    // stuck doing
    const stuck = ctx.notes.create(
      {
        body: '# stuck\n\nan in-progress ticket that has stalled for weeks now ' +
          'without any follow-up activity at all.',
        folderId: folder.id,
        source: 'user',
        status: 'doing',
      },
      'user',
    );
    ctx.handle.db
      .prepare('UPDATE notes SET updated_at = ? WHERE id = ?')
      .run(now - 30 * DAY_MS, stuck.id);
    // strikethrough title
    const broken = ctx.notes.create(
      {
        body: '~~scrapped~~\n\nReplacement direction is documented in another ticket.',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    void broken;
    // short body
    const tiny = ctx.notes.create(
      { body: '# tiny', folderId: folder.id, source: 'user' },
      'user',
    );
    void tiny;

    const findings = runTier0Checks(ctx.handle.db, folder.id, { now });
    const kinds = new Set(findings.map((f) => f.kind));
    expect(kinds.has('stuck_doing')).toBe(true);
    expect(kinds.has('broken_title_strikethrough')).toBe(true);
    expect(kinds.has('short_body')).toBe(true);
  });

  it('returns empty array when folder is clean', () => {
    const folder = ctx.folders.create('F');
    ctx.notes.create(
      {
        body:
          '# Clean ticket\n\nThis ticket is perfectly fine: tagged, sized ' +
          'reasonably, no strike-through prefix, status fresh.',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    const findings = runTier0Checks(ctx.handle.db, folder.id);
    // We didn't add a tag — `no_tags` is expected, but stuck_doing /
    // broken_title / short_body should not fire on a healthy ticket.
    const nonInfo = findings.filter((f) => f.kind !== 'no_tags');
    expect(nonInfo).toHaveLength(0);
  });
});

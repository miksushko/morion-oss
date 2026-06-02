import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import {
  ensurePatrolLogNote,
  appendFindings,
  renderFindingsSection,
  type Tier0Finding,
} from '../src/core/concierge/index.js';

interface Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  return {
    handle,
    audit,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
  };
}

const f = (kind: Tier0Finding['kind'], noteId: string, severity: Tier0Finding['severity']): Tier0Finding => ({
  kind,
  severity,
  noteId,
  noteTitle: `Title for ${noteId}`,
  message: `${kind} on ${noteId}`,
  context: {},
});

describe('ensurePatrolLogNote', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('creates a patrol-log note on first call with the right source', () => {
    const folder = ctx.folders.create('F');
    const note = ensurePatrolLogNote(ctx.handle.db, ctx.notes, folder.id);
    expect(note.source).toBe('mo:patrol-log');
    expect(note.body).toContain('# Mo Patrol Log');
    expect(note.folderId).toBe(folder.id);
  });

  it('is idempotent — subsequent calls return the same note', () => {
    const folder = ctx.folders.create('F');
    const a = ensurePatrolLogNote(ctx.handle.db, ctx.notes, folder.id);
    const b = ensurePatrolLogNote(ctx.handle.db, ctx.notes, folder.id);
    expect(b.id).toBe(a.id);
  });

  it('writes an audit row with the concierge actor on creation', () => {
    const folder = ctx.folders.create('F');
    const note = ensurePatrolLogNote(ctx.handle.db, ctx.notes, folder.id);
    const audit = ctx.handle.db
      .prepare(`SELECT actor, action FROM audit_log WHERE note_id = ? ORDER BY ts ASC`)
      .all(note.id) as Array<{ actor: string; action: string }>;
    expect(audit[0]!.actor).toBe('morion-concierge');
    expect(audit[0]!.action).toBe('create');
  });
});

describe('appendFindings', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('appends a section with one bullet per finding, severity-sorted', () => {
    const folder = ctx.folders.create('F');
    const findings: Tier0Finding[] = [
      f('no_tags', '01NOTE000000000000000000A', 'info'),
      f('stuck_doing', '01NOTE000000000000000000B', 'p1'),
      f('broken_title_strikethrough', '01NOTE000000000000000000C', 'warn'),
    ];
    const { note, appended } = appendFindings(
      ctx.handle.db,
      ctx.notes,
      folder.id,
      findings,
      { now: Date.UTC(2026, 3, 28, 9, 30) },
    );
    expect(appended).toBe(3);
    expect(note.body).toContain('## 2026-04-28 09:30 UTC');
    expect(note.body).toContain('stuck_doing');
    // P1 listed before P2/warn/info in the section.
    const stuckIdx = note.body.indexOf('stuck_doing');
    const warnIdx = note.body.indexOf('broken_title_strikethrough');
    const infoIdx = note.body.indexOf('no_tags');
    expect(stuckIdx).toBeLessThan(warnIdx);
    expect(warnIdx).toBeLessThan(infoIdx);
  });

  it('appending twice produces two date-stamped sections, both visible', () => {
    const folder = ctx.folders.create('F');
    const t1 = Date.UTC(2026, 3, 28, 9, 0);
    const t2 = Date.UTC(2026, 3, 28, 11, 0);

    appendFindings(
      ctx.handle.db,
      ctx.notes,
      folder.id,
      [f('stuck_doing', '01A', 'p2')],
      { now: t1 },
    );
    const { note } = appendFindings(
      ctx.handle.db,
      ctx.notes,
      folder.id,
      [f('no_tags', '01B', 'info')],
      { now: t2 },
    );
    expect(note.body).toContain('## 2026-04-28 09:00 UTC');
    expect(note.body).toContain('## 2026-04-28 11:00 UTC');
  });

  it('skipEmpty=true with empty findings does not write a section', () => {
    const folder = ctx.folders.create('F');
    const { note, appended } = appendFindings(
      ctx.handle.db,
      ctx.notes,
      folder.id,
      [],
      { now: Date.UTC(2026, 3, 28, 9, 0), skipEmpty: true },
    );
    expect(appended).toBe(0);
    // Body has just the header block, no sections appended.
    expect(note.body).not.toContain('## 2026-04-28 09:00 UTC');
  });

  it('records an audit update row with the concierge actor per append', () => {
    const folder = ctx.folders.create('F');
    const { note } = appendFindings(
      ctx.handle.db,
      ctx.notes,
      folder.id,
      [f('stuck_doing', '01A', 'p2')],
    );
    const audit = ctx.handle.db
      .prepare(
        `SELECT actor, action FROM audit_log WHERE note_id = ? ORDER BY ts ASC`,
      )
      .all(note.id) as Array<{ actor: string; action: string }>;
    // Two rows: one create on ensurePatrolLogNote, one update on appendFindings.
    expect(audit).toHaveLength(2);
    expect(audit[1]!.action).toBe('update');
    expect(audit[1]!.actor).toBe('morion-concierge');
  });
});

describe('renderFindingsSection — pure formatting', () => {
  it('uses the configured stamp format and severity badges', () => {
    const ts = Date.UTC(2026, 3, 28, 9, 30);
    const out = renderFindingsSection(
      [f('stuck_doing', '01A', 'p1'), f('no_tags', '01B', 'info')],
      ts,
    );
    expect(out).toMatch(/^## 2026-04-28 09:30 UTC/);
    expect(out).toContain('`P1`');
    expect(out).toContain('`i`');
    expect(out).toContain('[01A]');
    expect(out).toContain('[01B]');
  });

  it('returns a "no findings" placeholder when given an empty list', () => {
    const out = renderFindingsSection([], Date.UTC(2026, 3, 28));
    expect(out).toContain('No findings');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { NoteCommentsRepository } from '../src/core/notes/comments-repository.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import {
  MoMemoryRepository,
  NoteMoClustersRepository,
  ensureCatalogNote,
  mergeCatalogDoc,
  renderCatalogSection,
} from '../src/core/concierge/index.js';
import { packageCodingContext } from '../src/core/auto-code/context-packager.js';

/**
 * Auto-code Phase 2 — context packager
 * (sub-ticket 01KQEECJV1WAGHK823T41SZ953).
 *
 * The packager is pure deterministic — composes a markdown prompt
 * from filesystem (CLAUDE.md) + DB sources (catalog overview,
 * workflow, mo.memory, related tickets, comments, audit). Tests
 * stand up an in-memory SQLite + a temp repo dir per case so each
 * section can be verified in isolation.
 */

interface Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  comments: NoteCommentsRepository;
  settings: SettingsRepository;
  moMemory: MoMemoryRepository;
  clusters: NoteMoClustersRepository;
  /** Temp dir used as the linked git repo (for CLAUDE.md reads). */
  repoPath: string;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const comments = new NoteCommentsRepository(handle.db);
  const settings = new SettingsRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const clusters = new NoteMoClustersRepository(handle.db);
  const repoPath = mkdtempSync(join(tmpdir(), 'morion-ctxpkg-repo-'));
  return {
    handle,
    audit,
    notes,
    folders,
    comments,
    settings,
    moMemory,
    clusters,
    repoPath,
  };
}

function teardown(ctx: Ctx): void {
  rmSync(ctx.repoPath, { recursive: true, force: true });
}

function pkg(
  ctx: Ctx,
  taskId: string,
  folderId: string,
  overrides: Partial<Parameters<typeof packageCodingContext>[0]> = {},
) {
  return packageCodingContext({
    taskId,
    folderId,
    repoPath: ctx.repoPath,
    db: ctx.handle.db,
    notes: ctx.notes,
    folders: ctx.folders,
    comments: ctx.comments,
    audit: ctx.audit,
    clusters: ctx.clusters,
    moMemory: ctx.moMemory,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Sanity / shape
// ---------------------------------------------------------------------------

describe('context-packager — basics', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => teardown(ctx));

  it('throws when the task does not exist', () => {
    const folder = ctx.folders.create('F');
    expect(() =>
      pkg(ctx, '01KQNOSUCHTASK00000000000', folder.id),
    ).toThrowError(/task .* not found/);
  });

  it('throws when the folder does not exist', () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create({ body: '# t', folderId: folder.id, source: 'user' }, 'user');
    expect(() => pkg(ctx, note.id, '01KQNOSUCHFOLDER0000000000')).toThrowError(
      /folder .* not found/,
    );
  });

  it('renders a minimal prompt with just the task when nothing else is configured', () => {
    const folder = ctx.folders.create('F');
    const task = ctx.notes.create(
      { body: '# Fix the login bug\n\nUsers hit 500.', folderId: folder.id, source: 'user' },
      'user',
    );
    const result = pkg(ctx, task.id, folder.id);
    expect(result.prompt).toContain('# Your task');
    // Body is rendered verbatim so the task's own first-line heading
    // appears as-is (no synthetic `## title` wrapper that would
    // duplicate it).
    expect(result.prompt).toContain('# Fix the login bug');
    expect(result.prompt).toContain('Users hit 500');
    // None of the optional sections should be rendered.
    expect(result.prompt).not.toContain('# Repository conventions');
    expect(result.prompt).not.toContain('# Project memory');
    expect(result.prompt).not.toContain('# Workflow rules');
    expect(result.prompt).not.toContain('# User preferences');
    expect(result.prompt).not.toContain('# Related tickets');
    expect(result.prompt).not.toContain('# Acceptance');
    expect(result.prompt).not.toContain('# Recent comments');
    expect(result.prompt).not.toContain('# Status history');
    // Diagnostics surface every section but only "task" is included.
    const taskDiag = result.sections.find((s) => s.id === 'task')!;
    expect(taskDiag.included).toBe(true);
    expect(taskDiag.charCount).toBeGreaterThan(0);
    for (const id of [
      'repo-conventions',
      'project-memory',
      'user-preferences',
      'related-tickets',
      'acceptance',
      'recent-comments',
      'status-history',
    ] as const) {
      expect(result.sections.find((s) => s.id === id)?.included).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Section composition
// ---------------------------------------------------------------------------

describe('context-packager — section composition', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => teardown(ctx));

  it('includes CLAUDE.md from the linked repo path', () => {
    writeFileSync(
      join(ctx.repoPath, 'CLAUDE.md'),
      '# Repo conventions\n\nUse pnpm.\n',
    );
    const folder = ctx.folders.create('F');
    const task = ctx.notes.create({ body: '# T', folderId: folder.id, source: 'user' }, 'user');
    const result = pkg(ctx, task.id, folder.id);
    expect(result.prompt).toContain('# Repository conventions');
    expect(result.prompt).toContain('Use pnpm');
  });

  it('includes mo:catalog overview when a catalog note exists', () => {
    const folder = ctx.folders.create('F');
    const ensured = ensureCatalogNote(ctx.handle.db, folder.id);
    const merged = mergeCatalogDoc(
      ensured.body,
      renderCatalogSection('overview', 'This project ships a Tetris demo for fun.'),
    );
    ctx.handle.db
      .prepare('UPDATE notes SET body = ? WHERE id = ?')
      .run(merged, ensured.id);
    const task = ctx.notes.create({ body: '# T', folderId: folder.id, source: 'user' }, 'user');
    const result = pkg(ctx, task.id, folder.id);
    expect(result.prompt).toContain('# Project memory');
    expect(result.prompt).toContain('Tetris demo');
  });

  it('includes Mo memory from the workspace KV', () => {
    ctx.moMemory.write('User prefers tabs over spaces.');
    const folder = ctx.folders.create('F');
    const task = ctx.notes.create({ body: '# T', folderId: folder.id, source: 'user' }, 'user');
    const result = pkg(ctx, task.id, folder.id);
    expect(result.prompt).toContain('# User preferences (Mo Memory)');
    expect(result.prompt).toContain('tabs over spaces');
  });

  it('hoists `## Acceptance` section to the top + elides it from the task body', () => {
    const folder = ctx.folders.create('F');
    // Note: a trailing `## Notes` heading after Acceptance scopes
    // the acceptance section per standard markdown semantics. Without
    // a closing heading every paragraph below would still belong to
    // the Acceptance section — the regex respects markdown structure.
    const task = ctx.notes.create(
      {
        body: `# Bug fix

Background paragraph.

## Acceptance

- npm test passes
- no console.log in src/

## Notes

Trailing paragraph.`,
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    const result = pkg(ctx, task.id, folder.id);
    expect(result.prompt).toContain('# Acceptance criteria');
    expect(result.prompt).toContain('npm test passes');
    // The acceptance section should appear BEFORE the task section.
    expect(result.prompt.indexOf('# Acceptance criteria')).toBeLessThan(
      result.prompt.indexOf('# Your task'),
    );
    // The acceptance bullets should NOT appear inside the task body
    // section (avoid duplication).
    const taskSliceStart = result.prompt.indexOf('# Your task');
    const taskSlice = result.prompt.slice(taskSliceStart);
    expect(taskSlice).not.toContain('npm test passes');
    expect(taskSlice).toContain('Background paragraph');
    expect(taskSlice).toContain('Trailing paragraph');
  });

  it('also recognises `## Acceptance criteria` heading variant', () => {
    const folder = ctx.folders.create('F');
    const task = ctx.notes.create(
      {
        body: '## Acceptance criteria\n\n- merge cleanly\n',
        folderId: folder.id,
        source: 'user',
      },
      'user',
    );
    const result = pkg(ctx, task.id, folder.id);
    expect(result.prompt).toContain('# Acceptance criteria');
    expect(result.prompt).toContain('merge cleanly');
  });

  it('related tickets pulls peers via cluster JOIN, dedup + cross-folder filter', () => {
    const folderA = ctx.folders.create('A');
    const folderB = ctx.folders.create('B');
    const main = ctx.notes.create(
      { body: '# main task', folderId: folderA.id, source: 'user' },
      'user',
    );
    const peer1 = ctx.notes.create(
      { body: '# peer 1\nbody one', folderId: folderA.id, source: 'user' },
      'user',
    );
    const peer2 = ctx.notes.create(
      { body: '# peer 2\nbody two', folderId: folderA.id, source: 'user' },
      'user',
    );
    // peer3 lives in folder B — must be EXCLUDED (cross-folder noise).
    const peer3 = ctx.notes.create(
      { body: '# peer 3\nin other folder', folderId: folderB.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: main.id, clusterId: 'login-bugs', source: 'tier1' });
    ctx.clusters.upsert({ noteId: peer1.id, clusterId: 'login-bugs', source: 'tier1' });
    ctx.clusters.upsert({ noteId: peer2.id, clusterId: 'login-bugs', source: 'tier1' });
    ctx.clusters.upsert({ noteId: peer3.id, clusterId: 'login-bugs', source: 'tier1' });

    const result = pkg(ctx, main.id, folderA.id);
    expect(result.prompt).toContain('# Related tickets');
    expect(result.prompt).toContain(peer1.id);
    expect(result.prompt).toContain(peer2.id);
    expect(result.prompt).not.toContain(peer3.id);
    // Don't include the ticket itself.
    expect(result.prompt.split(main.id).length - 1).toBe(0); // main.id appears 0 times in related list
  });

  it('related-tickets respects the relatedLimit param', () => {
    const folder = ctx.folders.create('F');
    const main = ctx.notes.create({ body: '# m', folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: main.id, clusterId: 'theme', source: 'tier1' });
    for (let i = 0; i < 10; i++) {
      const p = ctx.notes.create(
        { body: `# peer ${i}`, folderId: folder.id, source: 'user' },
        'user',
      );
      ctx.clusters.upsert({ noteId: p.id, clusterId: 'theme', source: 'tier1' });
    }
    const result = pkg(ctx, main.id, folder.id, { relatedLimit: 3 });
    // Count `- 01K` occurrences in the rendered list.
    const matches = result.prompt.match(/- 01K[A-Z0-9]{23}/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it('recent comments + status history are rendered when present', () => {
    const folder = ctx.folders.create('F');
    const task = ctx.notes.create({ body: '# T', folderId: folder.id, source: 'user' }, 'user');
    ctx.comments.create(task.id, 'this is a code review note', 'user');
    // Move the task through a status to generate audit entries.
    ctx.notes.moveToKanban(task.id, 'todo', null, 'user');
    const result = pkg(ctx, task.id, folder.id);
    expect(result.prompt).toContain('# Recent comments');
    expect(result.prompt).toContain('code review note');
    expect(result.prompt).toContain('# Status history');
    expect(result.prompt).toContain('todo');
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe('context-packager — truncation', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => teardown(ctx));

  it('drops least-important sections first when over budget', () => {
    const folder = ctx.folders.create('F');
    // Big mo:catalog overview so total is large.
    writeFileSync(join(ctx.repoPath, 'CLAUDE.md'), 'X'.repeat(2_000));
    ctx.moMemory.write('Z'.repeat(500));
    const main = ctx.notes.create({ body: '# main', folderId: folder.id, source: 'user' }, 'user');
    ctx.clusters.upsert({ noteId: main.id, clusterId: 'theme', source: 'tier1' });
    for (let i = 0; i < 5; i++) {
      const peer = ctx.notes.create(
        { body: '# peer ' + 'p'.repeat(300), folderId: folder.id, source: 'user' },
        'user',
      );
      ctx.clusters.upsert({ noteId: peer.id, clusterId: 'theme', source: 'tier1' });
    }
    ctx.comments.create(main.id, 'C'.repeat(500), 'user');
    ctx.notes.moveToKanban(main.id, 'todo', null, 'user');

    // Budget tight enough to force truncation but not below
    // essentials (task + acceptance + mo.memory).
    const result = pkg(ctx, main.id, folder.id, { maxChars: 2_500 });

    // Essential sections survive.
    expect(result.sections.find((s) => s.id === 'task')!.included).toBe(true);
    expect(result.sections.find((s) => s.id === 'user-preferences')!.included).toBe(true);
    // Truncation order: related-tickets first.
    const related = result.sections.find((s) => s.id === 'related-tickets')!;
    expect(related.truncated).toBe(true);
    expect(result.prompt).not.toContain('# Related tickets');
  });

  it('flags oversize=true when essentials alone exceed maxChars', () => {
    const folder = ctx.folders.create('F');
    // Mo memory is one of the essentials — pump it past the cap.
    ctx.moMemory.write('X'.repeat(60_000));
    const task = ctx.notes.create({ body: '# T', folderId: folder.id, source: 'user' }, 'user');
    const result = pkg(ctx, task.id, folder.id);
    expect(result.oversize).toBe(true);
  });

  it('does not flag oversize when total comfortably fits', () => {
    const folder = ctx.folders.create('F');
    const task = ctx.notes.create({ body: '# T', folderId: folder.id, source: 'user' }, 'user');
    const result = pkg(ctx, task.id, folder.id);
    expect(result.oversize).toBe(false);
    expect(result.totalChars).toBeLessThan(50_000);
  });
});

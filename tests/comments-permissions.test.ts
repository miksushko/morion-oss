import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { RevisionsRepository } from '../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import { NoteCommentsRepository } from '../src/core/notes/comments-repository.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import { canEditComment } from '../src/core/permissions/comments.js';
import type { ToolContext } from '../src/server/tools/types.js';

interface Ctx {
  handle: DbHandle;
  tc: ToolContext;
  settings: SettingsRepository;
  notes: NotesRepository;
  comments: NoteCommentsRepository;
}

function setup(actor: string): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const revisions = new RevisionsRepository(handle.db);
  const attachments = new AttachmentsRepository(handle.db);
  const comments = new NoteCommentsRepository(handle.db);
  const settings = new SettingsRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const search = new HybridSearch(handle.db, fts, vec, embeddings);
  const indexer = new Indexer(vec, embeddings);
  const tc: ToolContext = {
    db: handle.db,
    notes,
    folders,
    tags,
    revisions,
    attachments,
    comments,
    search,
    indexer,
    audit,
    settings,
    actor,
    configDir: '/tmp/unused-for-comments-tests',
  };
  return { handle, tc, settings, notes, comments };
}

describe('canEditComment — actor-match precedence', () => {
  it('returns actor_mismatch when actor differs', () => {
    const ctx = setup('user');
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const comment = ctx.comments.create(note.id, 'by user', 'user')!;

    // Switch context actor to an MCP client attempting to edit the user's comment.
    const hostileCtx: ToolContext = { ...ctx.tc, actor: 'mcp:claude-desktop' };
    const decision = canEditComment(comment, hostileCtx);
    expect(decision).toEqual({ ok: false, reason: 'actor_mismatch' });
  });

  it('checks actor_mismatch BEFORE mcp_comments_editable kill-switch', () => {
    const ctx = setup('mcp:claude-desktop');
    // Even with the kill-switch OFF (which would block MCP), a non-matching
    // actor should return actor_mismatch first — the cheapest + most-
    // specific denial.
    ctx.settings.setMcpCommentsEditable(false);
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const comment = ctx.comments.create(note.id, 'by cursor', 'mcp:cursor')!;

    const decision = canEditComment(comment, ctx.tc);
    expect(decision).toEqual({ ok: false, reason: 'actor_mismatch' });
  });
});

describe('canEditComment — settings kill-switch', () => {
  it('blocks MCP actors when kill-switch is off even on own comments', () => {
    const ctx = setup('mcp:claude-desktop');
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const comment = ctx.comments.create(note.id, 'by cd', 'mcp:claude-desktop')!;

    ctx.settings.setMcpCommentsEditable(false);
    const decision = canEditComment(comment, ctx.tc);
    expect(decision).toEqual({ ok: false, reason: 'mcp_disabled' });
  });

  it('does NOT block UI actor="user" even when kill-switch is off', () => {
    const ctx = setup('user');
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const comment = ctx.comments.create(note.id, 'by user', 'user')!;

    ctx.settings.setMcpCommentsEditable(false);
    const decision = canEditComment(comment, ctx.tc);
    // User still owns their own post regardless of MCP kill-switch.
    expect(decision).toEqual({ ok: true });
  });

  it('allows MCP edit on own comment when kill-switch is on (default)', () => {
    const ctx = setup('mcp:claude-desktop');
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const comment = ctx.comments.create(note.id, 'by cd', 'mcp:claude-desktop')!;

    // Default getMcpCommentsEditable() → true.
    const decision = canEditComment(comment, ctx.tc);
    expect(decision).toEqual({ ok: true });
  });
});

describe('canEditComment — Free tier short-circuits permission engine', () => {
  it('canPerform returns true when isPro is false — no permission denial on Free', () => {
    const ctx = setup('user');
    const note = ctx.notes.create({ body: '# A\n\nb', source: 'user' }, 'user');
    const comment = ctx.comments.create(note.id, 'hi', 'user')!;

    // Fresh DB → no license → Free tier. canPerform is permissive.
    const decision = canEditComment(comment, ctx.tc);
    expect(decision).toEqual({ ok: true });
  });
});

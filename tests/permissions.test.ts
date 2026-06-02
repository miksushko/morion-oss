import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { RevisionsRepository } from '../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { canPerform, filterReadable, ACCESS_DENIED } from '../src/core/permissions/check.js';
import type { ToolContext } from '../src/server/tools/types.js';
import { foldersDeleteTool } from '../src/server/tools/folders_delete.js';
import { foldersRenameTool } from '../src/server/tools/folders_rename.js';
import { foldersMoveTool } from '../src/server/tools/folders_move.js';
import { foldersReorderTool } from '../src/server/tools/folders_reorder.js';
import { foldersDuplicateTool } from '../src/server/tools/folders_duplicate.js';
import { foldersCreateTool } from '../src/server/tools/folders_create.js';

/**
 * Permission engine + license-tier short-circuit.
 *
 * Two themes:
 *   1. On Free tier (default), canPerform returns true unconditionally —
 *      everything stays as-is, no enforcement. Mirrors v0.97 behaviour.
 *   2. On Pro tier (license set), folder + note permission flags gate
 *      the action. Note overrides take precedence; folder visibility
 *      always wins for hiding (a folder that's invisible hides its
 *      notes regardless of per-note overrides).
 */


interface Ctx {
  handle: DbHandle;
  tc: ToolContext;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const revisions = new RevisionsRepository(handle.db);
  const attachments = new AttachmentsRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const search = new HybridSearch(handle.db, fts, vec, embeddings);
  const indexer = new Indexer(vec, embeddings);
  const settings = new SettingsRepository(handle.db);
  return {
    handle,
    tc: {
      db: handle.db,
      notes,
      folders,
      tags,
      revisions,
      attachments,
      search,
      indexer,
      audit,
      settings,
      actor: 'mcp:test',
      configDir: '/tmp/morion-test-perms',
    },
  };
}

function activatePro(_ctx: Ctx): void {
  // no-op: open-source build has no license tier (kept for call-site compatibility)
}

describe('canPerform — user-actor bypass (regression 2026-04-25)', () => {
  // CRITICAL bug: a Pro user toggling "Visible to AI = false" on a
  // folder lost access to their own notes in the UI. canPerform was
  // applying the Pro permission gate to ALL callers; should gate only
  // mcp:* actors. User UI must NEVER be filtered by MCP permissions.
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    ctx.tc.actor = 'user';
    activatePro(ctx);
  });

  it('user-actor sees an invisible folder on Pro (UI bypass)', () => {
    const folder = ctx.tc.folders.create('Hidden from AI');
    ctx.tc.folders.setMcpPermissions(folder.id, {
      visible: false,
      create: false,
      update: false,
      delete: false,
    });
    expect(canPerform('read', ctx.tc, { kind: 'folder', folderId: folder.id })).toBe(true);
    expect(canPerform('update', ctx.tc, { kind: 'folder', folderId: folder.id })).toBe(true);
    expect(canPerform('delete', ctx.tc, { kind: 'folder', folderId: folder.id })).toBe(true);
  });

  it('user-actor sees an invisible note on Pro', () => {
    const folder = ctx.tc.folders.create('Mixed');
    ctx.tc.folders.setMcpPermissions(folder.id, {
      visible: true,
      create: true,
      update: true,
      delete: true,
    });
    const note = ctx.tc.notes.create({ folderId: folder.id, title: 'n', body: '', source: 'user' }, 'user');
    ctx.tc.notes.setMcpPermissions(note.id, { visible: false, update: null, delete: null });
    expect(canPerform('read', ctx.tc, { kind: 'note', noteId: note.id })).toBe(true);
    expect(canPerform('update', ctx.tc, { kind: 'note', noteId: note.id })).toBe(true);
  });

  it('filterReadable is a no-op for user-actor on Pro', () => {
    const visibleFolder = ctx.tc.folders.create('Visible');
    const hiddenFolder = ctx.tc.folders.create('Hidden');
    ctx.tc.folders.setMcpPermissions(hiddenFolder.id, {
      visible: false,
      create: false,
      update: false,
      delete: false,
    });
    const all = ctx.tc.folders.list();
    expect(filterReadable(all, ctx.tc).map((f) => f.id).sort()).toEqual(
      [visibleFolder.id, hiddenFolder.id].sort(),
    );
  });

  it('mcp-actor still gets filtered (sanity — no regression on the AI path)', () => {
    const visibleFolder = ctx.tc.folders.create('Visible');
    const hiddenFolder = ctx.tc.folders.create('Hidden');
    ctx.tc.folders.setMcpPermissions(hiddenFolder.id, {
      visible: false,
      create: false,
      update: false,
      delete: false,
    });
    ctx.tc.actor = 'mcp:test';
    const all = ctx.tc.folders.list();
    expect(filterReadable(all, ctx.tc).map((f) => f.id)).toEqual([visibleFolder.id]);
    expect(canPerform('read', ctx.tc, { kind: 'folder', folderId: hiddenFolder.id })).toBe(false);
  });
});

describe('canPerform — folder gates', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx);
  });

  it('blocks every action on an invisible folder', () => {
    const folder = ctx.tc.folders.create('Hidden');
    ctx.tc.folders.setMcpPermissions(folder.id, {
      visible: false,
      create: true,
      update: true,
      delete: true,
    });
    expect(canPerform('read', ctx.tc, { kind: 'folder', folderId: folder.id })).toBe(false);
    expect(canPerform('create', ctx.tc, { kind: 'folder', folderId: folder.id })).toBe(false);
    expect(canPerform('update', ctx.tc, { kind: 'folder', folderId: folder.id })).toBe(false);
    expect(canPerform('delete', ctx.tc, { kind: 'folder', folderId: folder.id })).toBe(false);
  });

  it('blocks create/update/delete independently when visible', () => {
    const folder = ctx.tc.folders.create('Read-only');
    ctx.tc.folders.setMcpPermissions(folder.id, {
      visible: true,
      create: false,
      update: false,
      delete: false,
    });
    expect(canPerform('read', ctx.tc, { kind: 'folder', folderId: folder.id })).toBe(true);
    expect(canPerform('create', ctx.tc, { kind: 'folder', folderId: folder.id })).toBe(false);
    expect(canPerform('update', ctx.tc, { kind: 'folder', folderId: folder.id })).toBe(false);
    expect(canPerform('delete', ctx.tc, { kind: 'folder', folderId: folder.id })).toBe(false);
  });

  it('returns false for a folder that does not exist', () => {
    expect(canPerform('read', ctx.tc, { kind: 'folder', folderId: 'no-such-folder' })).toBe(false);
  });
});

describe('canPerform — Pro tier note inheritance', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx);
  });

  it('hides a note when the parent folder is invisible, even if note.visible is true', () => {
    const folder = ctx.tc.folders.create('Hidden');
    ctx.tc.folders.setMcpPermissions(folder.id, {
      visible: false,
      create: true,
      update: true,
      delete: true,
    });
    const note = ctx.tc.notes.create({ body: 'X', folderId: folder.id, source: 'user' }, 'user');
    ctx.tc.notes.setMcpPermissions(note.id, { visible: true, update: null, delete: null });
    expect(canPerform('read', ctx.tc, { kind: 'note', noteId: note.id })).toBe(false);
  });

  it('lets a per-note deny override an otherwise-allowed folder', () => {
    const folder = ctx.tc.folders.create('Open');
    const note = ctx.tc.notes.create({ body: 'X', folderId: folder.id, source: 'user' }, 'user');
    ctx.tc.notes.setMcpPermissions(note.id, { visible: false, update: null, delete: null });
    expect(canPerform('read', ctx.tc, { kind: 'note', noteId: note.id })).toBe(false);
  });

  it('inherits all-allow when both folder and note overrides are null/default', () => {
    const folder = ctx.tc.folders.create('Open');
    const note = ctx.tc.notes.create({ body: 'X', folderId: folder.id, source: 'user' }, 'user');
    expect(canPerform('read', ctx.tc, { kind: 'note', noteId: note.id })).toBe(true);
    expect(canPerform('update', ctx.tc, { kind: 'note', noteId: note.id })).toBe(true);
    expect(canPerform('delete', ctx.tc, { kind: 'note', noteId: note.id })).toBe(true);
  });

  it('lets a note override RE-allow what the folder would deny update/delete', () => {
    const folder = ctx.tc.folders.create('No edits');
    ctx.tc.folders.setMcpPermissions(folder.id, {
      visible: true,
      create: true,
      update: false,
      delete: false,
    });
    const note = ctx.tc.notes.create({ body: 'X', folderId: folder.id, source: 'user' }, 'user');
    // Note explicit allow doesn't override a folder-level deny — folder
    // wins for the gates it owns. (Re-allow at note level is only
    // possible when the folder allows; deny can override down).
    expect(canPerform('update', ctx.tc, { kind: 'note', noteId: note.id })).toBe(false);
    expect(canPerform('delete', ctx.tc, { kind: 'note', noteId: note.id })).toBe(false);
  });
});

describe('canPerform — newNote (create) target', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx);
  });

  it('blocks creation in a folder with mcp_create=false', () => {
    const folder = ctx.tc.folders.create('Read-only');
    ctx.tc.folders.setMcpPermissions(folder.id, {
      visible: true,
      create: false,
      update: true,
      delete: true,
    });
    expect(canPerform('create', ctx.tc, { kind: 'newNote', folderId: folder.id })).toBe(false);
  });

  it('uses the unfiled defaults when folderId is null', () => {
    // Default unfiledMcpPermissions is all-true → allowed.
    expect(canPerform('create', ctx.tc, { kind: 'newNote', folderId: null })).toBe(true);
    // Override unfiled to deny create → denied.
    ctx.tc.settings.set('unfiledMcpPermissions', { visible: true, create: false, update: true, delete: true });
    expect(canPerform('create', ctx.tc, { kind: 'newNote', folderId: null })).toBe(false);
  });
});

describe('filterReadable', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx);
  });

  it('removes folders the caller cannot read', () => {
    const open = ctx.tc.folders.create('Open');
    const hidden = ctx.tc.folders.create('Hidden');
    ctx.tc.folders.setMcpPermissions(hidden.id, {
      visible: false,
      create: true,
      update: true,
      delete: true,
    });
    const all = ctx.tc.folders.list();
    const visible = filterReadable(all, ctx.tc);
    expect(visible.map((f) => f.id)).toContain(open.id);
    expect(visible.map((f) => f.id)).not.toContain(hidden.id);
  });

  it('removes notes whose folder is hidden', () => {
    const hidden = ctx.tc.folders.create('Hidden');
    ctx.tc.folders.setMcpPermissions(hidden.id, {
      visible: false,
      create: true,
      update: true,
      delete: true,
    });
    const noteInHidden = ctx.tc.notes.create({ body: 'A', folderId: hidden.id, source: 'user' }, 'user');
    const noteUnfiled = ctx.tc.notes.create({ body: 'B', folderId: null, source: 'user' }, 'user');
    const all = ctx.tc.notes.list({ limit: 10, offset: 0 });
    const visible = filterReadable(all, ctx.tc);
    expect(visible.map((n) => n.id)).not.toContain(noteInHidden.id);
    expect(visible.map((n) => n.id)).toContain(noteUnfiled.id);
  });
});

/**
 * Regression coverage for the 2026-04-16 audit finding N1 — every folder
 * mutation tool must gate through canPerform() and return ACCESS_DENIED on
 * deny. Before the fix these tools reached the repo unconditionally, letting
 * a Pro MCP client bypass the per-folder permission system.
 */
describe('Folder mutation tools — canPerform gates', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activatePro(ctx);
  });

  function lockFolder(name: string) {
    const folder = ctx.tc.folders.create(name);
    ctx.tc.folders.setMcpPermissions(folder.id, {
      visible: true,
      create: false,
      update: false,
      delete: false,
    });
    return folder;
  }

  it('folders_delete returns ACCESS_DENIED when mcp_delete=false', async () => {
    const folder = lockFolder('Locked');
    const result = await foldersDeleteTool.handler({ id: folder.id }, ctx.tc);
    expect(result).toEqual(ACCESS_DENIED);
    // The folder is still there.
    expect(ctx.tc.folders.getById(folder.id)).not.toBeNull();
  });

  it('folders_rename returns ACCESS_DENIED when mcp_update=false', async () => {
    const folder = lockFolder('Locked');
    const result = await foldersRenameTool.handler(
      { id: folder.id, name: 'Rogue' },
      ctx.tc,
    );
    expect(result).toEqual(ACCESS_DENIED);
    expect(ctx.tc.folders.getById(folder.id)?.name).toBe('Locked');
  });

  it('folders_move returns ACCESS_DENIED when mcp_update=false', async () => {
    ctx.tc.folders.create('First');
    const locked = lockFolder('Locked');
    const result = await foldersMoveTool.handler(
      { id: locked.id, direction: 'up' },
      ctx.tc,
    );
    expect(result).toEqual(ACCESS_DENIED);
  });

  it('folders_reorder refuses if any folder in the list is update-denied', async () => {
    const open = ctx.tc.folders.create('Open');
    const locked = lockFolder('Locked');
    const result = await foldersReorderTool.handler(
      { orderedIds: [locked.id, open.id] },
      ctx.tc,
    );
    expect(result).toEqual(ACCESS_DENIED);
  });

  it('folders_duplicate returns ACCESS_DENIED when the source folder is invisible', async () => {
    const hidden = ctx.tc.folders.create('Hidden');
    ctx.tc.folders.setMcpPermissions(hidden.id, {
      visible: false,
      create: true,
      update: true,
      delete: true,
    });
    const result = await foldersDuplicateTool.handler({ id: hidden.id }, ctx.tc);
    expect(result).toEqual(ACCESS_DENIED);
  });

  it('folders_create with a parentId requires create on the parent', async () => {
    const locked = lockFolder('Locked');
    const result = await foldersCreateTool.handler(
      { name: 'child', parentId: locked.id },
      ctx.tc,
    );
    expect(result).toEqual(ACCESS_DENIED);
  });

  it('folders_create at top level is always allowed on Pro', async () => {
    const result = await foldersCreateTool.handler({ name: 'top' }, ctx.tc);
    // ACCESS_DENIED is a literal object — anything else means it succeeded.
    expect(result).not.toEqual(ACCESS_DENIED);
    expect(result).toHaveProperty('id');
  });

  it('folders_move succeeds on an update-allowed folder', async () => {
    const a = ctx.tc.folders.create('A');
    ctx.tc.folders.create('B');
    const result = await foldersMoveTool.handler(
      { id: a.id, direction: 'down' },
      ctx.tc,
    );
    expect(result).not.toEqual(ACCESS_DENIED);
    expect(Array.isArray(result)).toBe(true);
  });

  it('folders_rename succeeds on an update-allowed folder', async () => {
    const folder = ctx.tc.folders.create('Original');
    const result = await foldersRenameTool.handler(
      { id: folder.id, name: 'Renamed' },
      ctx.tc,
    );
    expect(result).not.toEqual(ACCESS_DENIED);
    expect(ctx.tc.folders.getById(folder.id)?.name).toBe('Renamed');
  });
});


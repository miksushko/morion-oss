import { beforeEach, describe, expect, it } from 'vitest';
import {
  foldersCreateTool,
  foldersDeleteTool,
  foldersDuplicateTool,
  foldersListTool,
  foldersMoveTool,
  foldersRenameTool,
  foldersReorderTool,
  notesCreateTool,
  notesGetTool,
} from '../src/server/tools/index.js';
import { type Ctx, setup } from './mcp-tools/helpers.js';
import type { Note, Folder } from '../src/core/notes/types.js';

describe('MCP tools — folders', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  describe('folders_list', () => {
    it('returns all folders ordered by position', async () => {
      ctx.tc.folders.create('Work');
      ctx.tc.folders.create('Personal');

      const result = (await foldersListTool.handler({}, ctx.tc)) as Folder[];
      expect(result.map((f) => f.name)).toEqual(['Work', 'Personal']);
    });
  });

  describe('folders_create', () => {
    it('creates a top-level folder when parentId is omitted', async () => {
      const created = (await foldersCreateTool.handler({ name: 'Projects' }, ctx.tc)) as Folder;
      expect(created.id).toBeTruthy();
      expect(created.name).toBe('Projects');
      expect(created.parentId).toBeNull();
    });

    it('honors an explicit null parentId', async () => {
      const created = (await foldersCreateTool.handler(
        { name: 'Inbox-ish', parentId: null },
        ctx.tc,
      )) as Folder;
      expect(created.parentId).toBeNull();
    });
  });

  describe('folders_rename', () => {
    it('renames an existing folder and returns the updated record', async () => {
      const created = ctx.tc.folders.create('Old name');
      const updated = (await foldersRenameTool.handler(
        { id: created.id, name: 'New name' },
        ctx.tc,
      )) as Folder;
      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe('New name');
    });

    it('returns mcp_access_denied for an unknown id (visibility gate)', async () => {
      const result = await foldersRenameTool.handler(
        { id: '01HXNOTREALID', name: 'whatever' },
        ctx.tc,
      );
      expect((result as { error?: string })?.error).toBe('mcp_access_denied');
    });
  });

  describe('folders_delete', () => {
    it('deletes a folder and unfiles its notes (folderId becomes null)', async () => {
      const folder = ctx.tc.folders.create('Doomed');
      const note = (await notesCreateTool.handler(
        { body: 'orphan-me', folderId: folder.id },
        ctx.tc,
      )) as Note;

      const result = (await foldersDeleteTool.handler({ id: folder.id }, ctx.tc)) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(ctx.tc.folders.getById(folder.id)).toBeNull();

      // Note survives, just unfiled.
      const stillThere = (await notesGetTool.handler({ id: note.id }, ctx.tc)) as Note | null;
      expect(stillThere).not.toBeNull();
      expect(stillThere?.folderId).toBeNull();
    });

    it('returns mcp_access_denied when the folder does not exist (visibility gate)', async () => {
      const result = (await foldersDeleteTool.handler(
        { id: '01HXNOTREALID' },
        ctx.tc,
      )) as { error?: string };
      expect(result.error).toBe('mcp_access_denied');
    });
  });

  describe('folders_reorder', () => {
    it('applies the new order from the supplied id list', async () => {
      const a = ctx.tc.folders.create('A');
      const b = ctx.tc.folders.create('B');
      const c = ctx.tc.folders.create('C');

      const result = (await foldersReorderTool.handler(
        { orderedIds: [c.id, a.id, b.id] },
        ctx.tc,
      )) as Folder[];

      expect(result.map((f) => f.name)).toEqual(['C', 'A', 'B']);
    });
  });

  describe('folders_duplicate', () => {
    it('clones a folder with notes', async () => {
      const work = ctx.tc.folders.create('Work');
      await notesCreateTool.handler(
        { body: '# A\n\na', folderId: work.id },
        ctx.tc,
      );
      await notesCreateTool.handler(
        { body: '# B\n\nb', folderId: work.id, tags: ['urgent'] },
        ctx.tc,
      );

      const copy = (await foldersDuplicateTool.handler({ id: work.id }, ctx.tc)) as Folder;
      expect(copy.name).toBe('Work (Copy)');
      expect(copy.noteCount).toBe(2);
      expect(copy.id).not.toBe(work.id);

      // Original folder still has its 2 notes (deep copy, not a move).
      const original = ctx.tc.folders.getById(work.id)!;
      expect(original.noteCount).toBe(2);
    });

    it('returns mcp_access_denied for a missing folder (visibility gate)', async () => {
      const result = await foldersDuplicateTool.handler({ id: 'does-not-exist' }, ctx.tc);
      expect((result as { error?: string })?.error).toBe('mcp_access_denied');
    });
  });

  describe('folders_move', () => {
    it('moves a folder up and down', async () => {
      const a = ctx.tc.folders.create('A');
      const b = ctx.tc.folders.create('B');
      ctx.tc.folders.create('C');

      const up = (await foldersMoveTool.handler(
        { id: b.id, direction: 'up' },
        ctx.tc,
      )) as Folder[];
      expect(up.map((f) => f.name)).toEqual(['B', 'A', 'C']);

      const cantUp = await foldersMoveTool.handler(
        { id: b.id, direction: 'up' },
        ctx.tc,
      );
      expect(cantUp).toBeNull();

      // a is now at index 1, can move down -> back to A,B,C? Let's verify.
      const down = (await foldersMoveTool.handler(
        { id: a.id, direction: 'up' },
        ctx.tc,
      )) as Folder[];
      expect(down.map((f) => f.name)).toEqual(['A', 'B', 'C']);
    });

    // The sidebar splits top-level folders into two visual groups (list vs
    // kanban). Move Up/Down must swap with the visually-adjacent folder of
    // the SAME view_mode — otherwise a list-folder swap can land on a
    // kanban folder by absolute position, the DB updates, but the user
    // sees nothing change in either group.
    it('only swaps with adjacent folder of the same view_mode', async () => {
      const l1 = ctx.tc.folders.create('L1');
      const k1 = ctx.tc.folders.create('K1');
      const l2 = ctx.tc.folders.create('L2');
      const k2 = ctx.tc.folders.create('K2');
      const l3 = ctx.tc.folders.create('L3');
      ctx.tc.folders.setViewMode(k1.id, 'kanban');
      ctx.tc.folders.setViewMode(k2.id, 'kanban');

      // Move L2 up: should swap with L1 (the adjacent LIST sibling),
      // not with K1 (the absolute-position-adjacent sibling).
      const after = (await foldersMoveTool.handler(
        { id: l2.id, direction: 'up' },
        ctx.tc,
      )) as Folder[];

      const lists = after.filter((f) => f.viewMode === 'list').map((f) => f.name);
      const kanbans = after.filter((f) => f.viewMode === 'kanban').map((f) => f.name);
      expect(lists).toEqual(['L2', 'L1', 'L3']);
      // Kanban group's relative order must be untouched.
      expect(kanbans).toEqual(['K1', 'K2']);
    });

    // Boundary check honours the view_mode group too: a list-folder that
    // is first in the LIST group must report "can't move up" even when
    // there's a kanban folder ahead of it in absolute position.
    it('returns null at the group-local boundary, not the absolute boundary', async () => {
      const k = ctx.tc.folders.create('K');
      const l1 = ctx.tc.folders.create('L1');
      ctx.tc.folders.create('L2');
      ctx.tc.folders.setViewMode(k.id, 'kanban');

      // L1 is at absolute index 1 (K is at 0), but it's index 0 within
      // the LIST group, so Up must refuse.
      const result = await foldersMoveTool.handler(
        { id: l1.id, direction: 'up' },
        ctx.tc,
      );
      expect(result).toBeNull();
    });
  });
});

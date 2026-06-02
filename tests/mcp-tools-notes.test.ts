import { beforeEach, describe, expect, it } from 'vitest';
import {
  notesAppendTool,
  notesCreateTool,
  notesDeleteTool,
  notesDuplicateTool,
  notesGetTool,
  notesListTool,
  notesMoveTool,
  notesRecentTool,
  notesSearchTool,
  notesUpdateTool,
} from '../src/server/tools/index.js';
import { type Ctx, setup } from './mcp-tools/helpers.js';
import type { Note } from '../src/core/notes/types.js';

describe('MCP tools — notes', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  describe('notes_create', () => {
    it('creates a note with title as first line of body', async () => {
      const result = (await notesCreateTool.handler(
        { body: '# Created by LLM\n\nSome content', tags: ['ai'] },
        ctx.tc,
      )) as Note;

      expect(result.id).toBeTruthy();
      expect(result.title).toBe('Created by LLM');
      expect(result.body).toBe('# Created by LLM\n\nSome content');
      expect(result.source).toBe('mcp:test-client');
      expect(result.tags).toEqual(['ai']);
    });

    it('creates a note via legacy title field (merges into body)', async () => {
      const result = (await notesCreateTool.handler(
        { title: 'Legacy Title', body: 'body content', tags: ['ai'] },
        ctx.tc,
      )) as Note;

      expect(result.title).toBe('Legacy Title');
      expect(result.body).toBe('# Legacy Title\n\nbody content');
    });

    it('records mutation in the audit log with actor', async () => {
      await notesCreateTool.handler({ body: '# Audit test' }, ctx.tc);
      const rows = ctx.handle.db
        .prepare('SELECT actor, action FROM audit_log ORDER BY id')
        .all() as { actor: string; action: string }[];
      expect(rows).toContainEqual({ actor: 'mcp:test-client', action: 'create' });
    });

    it('uses "user" as source when actor is not an MCP client', async () => {
      const userCtx = setup('user');
      const result = (await notesCreateTool.handler(
        { body: '# Human wrote this' },
        userCtx.tc,
      )) as Note;
      expect(result.source).toBe('user');
    });
  });

  describe('notes_get', () => {
    it('returns a created note by id', async () => {
      const created = (await notesCreateTool.handler(
        { body: '# To fetch\n\nx' },
        ctx.tc,
      )) as Note;

      const fetched = (await notesGetTool.handler({ id: created.id }, ctx.tc)) as Note | null;
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.title).toBe('To fetch');
    });

    it('returns mcp_access_denied for a missing id (visibility gate fires first)', async () => {
      const fetched = await notesGetTool.handler({ id: '01HXNOTREALID' }, ctx.tc);
      expect((fetched as { error?: string })?.error).toBe('mcp_access_denied');
    });
  });

  describe('notes_update', () => {
    it('patches body (and derived title), keeps tags when omitted', async () => {
      const created = (await notesCreateTool.handler(
        { body: '# Old\n\nold body', tags: ['keepme'] },
        ctx.tc,
      )) as Note;

      const updated = (await notesUpdateTool.handler(
        { id: created.id, body: '# New\n\nnew body' },
        ctx.tc,
      )) as Note;

      expect(updated.title).toBe('New');
      expect(updated.body).toBe('# New\n\nnew body');
      expect(updated.tags).toEqual(['keepme']);
    });

    it('replaces tags when tags are provided', async () => {
      const created = (await notesCreateTool.handler(
        { body: 'tagged', tags: ['a', 'b'] },
        ctx.tc,
      )) as Note;

      const updated = (await notesUpdateTool.handler(
        { id: created.id, tags: ['c'] },
        ctx.tc,
      )) as Note;

      expect(updated.tags).toEqual(['c']);
    });

    it('auto-snapshots the pre-mutation state into version history', async () => {
      const created = (await notesCreateTool.handler(
        { body: '# A\n\nfirst' },
        ctx.tc,
      )) as Note;

      await notesUpdateTool.handler(
        { id: created.id, body: '# A\n\nsecond' },
        ctx.tc,
      );

      // The snapshot is taken BEFORE the mutation, so the saved revision body
      // is the original — exactly what a Restore would roll back to.
      const revisions = ctx.tc.revisions.listForNote(created.id);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]!.body).toBe('# A\n\nfirst');
      expect(revisions[0]!.actor).toBe('mcp:test-client');
    });
  });

  describe('notes_delete', () => {
    it('soft-deletes and hides the note from subsequent reads', async () => {
      const created = (await notesCreateTool.handler(
        { body: 'bye' },
        ctx.tc,
      )) as Note;

      const result = (await notesDeleteTool.handler({ id: created.id }, ctx.tc)) as { ok: boolean };
      expect(result.ok).toBe(true);

      const fetched = await notesGetTool.handler({ id: created.id }, ctx.tc);
      expect(fetched).toBeNull();
    });
  });

  describe('notes_list', () => {
    it('filters by folder and returns pinned notes first', async () => {
      const folderA = ctx.tc.folders.create('A');
      const folderB = ctx.tc.folders.create('B');

      await notesCreateTool.handler({ body: 'A1', folderId: folderA.id }, ctx.tc);
      await notesCreateTool.handler({ body: 'A2', folderId: folderA.id, pinned: true }, ctx.tc);
      await notesCreateTool.handler({ body: 'B1', folderId: folderB.id }, ctx.tc);

      const inA = (await notesListTool.handler(
        { folderId: folderA.id, limit: 50, offset: 0 },
        ctx.tc,
      )) as Note[];

      expect(inA.map((n) => n.title)).toEqual(['A2', 'A1']);
    });
  });

  describe('notes_search', () => {
    it('returns ranked hits with snippet + score', async () => {
      await notesCreateTool.handler(
        { body: '# Quarterly planning\n\nRoadmap review with Alice on Tuesday.' },
        ctx.tc,
      );
      await notesCreateTool.handler(
        { body: '# Grocery\n\nmilk eggs bread' },
        ctx.tc,
      );

      const results = (await notesSearchTool.handler(
        { query: 'alice roadmap', limit: 10 },
        ctx.tc,
      )) as { title: string; snippet: string | null; score: number }[];

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.title).toBe('Quarterly planning');
      expect(results[0]!.snippet).toContain('<mark>');
    });
  });

  describe('notes_append', () => {
    it('appends with the default separator and bumps updated_at', async () => {
      const note = (await notesCreateTool.handler(
        { body: '# Standup\n\nfirst line' },
        ctx.tc,
      )) as Note;
      // Force a timestamp gap so we can compare updated_at deltas reliably.
      await new Promise((r) => setTimeout(r, 5));

      const updated = (await notesAppendTool.handler(
        { id: note.id, text: 'second line' },
        ctx.tc,
      )) as Note;

      expect(updated.body).toBe('# Standup\n\nfirst line\n\nsecond line');
      expect(updated.updatedAt).toBeGreaterThan(note.updatedAt);
    });

    it('respects a custom separator', async () => {
      const note = (await notesCreateTool.handler(
        { body: 'a' },
        ctx.tc,
      )) as Note;
      const updated = (await notesAppendTool.handler(
        { id: note.id, text: 'b', separator: ' | ' },
        ctx.tc,
      )) as Note;
      expect(updated.body).toBe('a | b');
    });

    it('appends without a separator when the body is empty', async () => {
      const note = (await notesCreateTool.handler(
        { body: '' },
        ctx.tc,
      )) as Note;
      const updated = (await notesAppendTool.handler(
        { id: note.id, text: 'kicked off' },
        ctx.tc,
      )) as Note;
      expect(updated.body).toBe('kicked off');
    });

    it('returns mcp_access_denied when the note does not exist (visibility gate)', async () => {
      const result = await notesAppendTool.handler(
        { id: '01HXNOTREALID', text: 'whatever' },
        ctx.tc,
      );
      expect((result as { error?: string })?.error).toBe('mcp_access_denied');
    });

    it('auto-snapshots the pre-append state into version history', async () => {
      const note = (await notesCreateTool.handler(
        { body: '# log\n\nline 1' },
        ctx.tc,
      )) as Note;
      await notesAppendTool.handler({ id: note.id, text: 'line 2' }, ctx.tc);

      const revisions = ctx.tc.revisions.listForNote(note.id);
      expect(revisions).toHaveLength(1);
      // Snapshot is the state BEFORE the append, so the saved body is the
      // original content — restoring it would erase the appended text.
      expect(revisions[0]!.body).toBe('# log\n\nline 1');
      expect(revisions[0]!.actor).toBe('mcp:test-client');
    });
  });

  describe('notes_duplicate', () => {
    it('clones title, body, folder, tags, and pinned with a fresh id', async () => {
      const folder = ctx.tc.folders.create('Templates');
      const original = (await notesCreateTool.handler(
        {
          body: '# Weekly review\n\n## What went well\n\n## What to change',
          folderId: folder.id,
          tags: ['review', 'template'],
          pinned: true,
        },
        ctx.tc,
      )) as Note;

      const dup = (await notesDuplicateTool.handler({ id: original.id }, ctx.tc)) as Note;
      expect(dup.id).not.toBe(original.id);
      expect(dup.title).toBe(original.title);
      expect(dup.body).toBe(original.body);
      expect(dup.folderId).toBe(folder.id);
      expect(dup.tags.sort()).toEqual(['review', 'template']);
      expect(dup.pinned).toBe(true);
      expect(dup.source).toBe('mcp:test-client');
    });

    it('writes a create row to the audit log', async () => {
      const original = (await notesCreateTool.handler(
        { body: 'src' },
        ctx.tc,
      )) as Note;
      ctx.handle.db.prepare('DELETE FROM audit_log').run();

      const dup = (await notesDuplicateTool.handler({ id: original.id }, ctx.tc)) as Note;
      const rows = ctx.handle.db
        .prepare('SELECT note_id, action, actor FROM audit_log ORDER BY id')
        .all() as { note_id: string; action: string; actor: string }[];
      expect(rows).toContainEqual({
        note_id: dup.id,
        action: 'create',
        actor: 'mcp:test-client',
      });
    });

    it('returns mcp_access_denied when the source note does not exist (visibility gate)', async () => {
      const result = await notesDuplicateTool.handler({ id: '01HXNOTREALID' }, ctx.tc);
      expect((result as { error?: string })?.error).toBe('mcp_access_denied');
    });
  });

  describe('notes_move', () => {
    it('moves a note into a different folder WITHOUT bumping updated_at', async () => {
      const work = ctx.tc.folders.create('Work');
      const personal = ctx.tc.folders.create('Personal');
      const note = (await notesCreateTool.handler(
        { body: '# thing\n\nbody', folderId: work.id },
        ctx.tc,
      )) as Note;
      // Force a real-time gap so a buggy bump would be detectable.
      await new Promise((r) => setTimeout(r, 5));

      const moved = (await notesMoveTool.handler(
        { id: note.id, folderId: personal.id },
        ctx.tc,
      )) as Note;

      expect(moved.folderId).toBe(personal.id);
      expect(moved.updatedAt).toBe(note.updatedAt);
    });

    it('unfiles a note when folderId is null', async () => {
      const work = ctx.tc.folders.create('Work');
      const note = (await notesCreateTool.handler(
        { body: 'thing', folderId: work.id },
        ctx.tc,
      )) as Note;

      const moved = (await notesMoveTool.handler(
        { id: note.id, folderId: null },
        ctx.tc,
      )) as Note;

      expect(moved.folderId).toBeNull();
    });

    it('returns mcp_access_denied when the note does not exist (visibility gate)', async () => {
      const result = await notesMoveTool.handler(
        { id: '01HXNOTREALID', folderId: null },
        ctx.tc,
      );
      expect((result as { error?: string })?.error).toBe('mcp_access_denied');
    });
  });

  describe('notes_recent', () => {
    it('returns notes ordered by updated_at desc, ignoring pin state', async () => {
      // a is created first, then b, then c. Pinning a must NOT push it ahead.
      const a = (await notesCreateTool.handler(
        { body: 'a', pinned: true },
        ctx.tc,
      )) as Note;
      await new Promise((r) => setTimeout(r, 3));
      const b = (await notesCreateTool.handler({ body: 'b' }, ctx.tc)) as Note;
      await new Promise((r) => setTimeout(r, 3));
      const c = (await notesCreateTool.handler({ body: 'c' }, ctx.tc)) as Note;

      const result = (await notesRecentTool.handler({}, ctx.tc)) as Note[];
      const ids = result.map((n) => n.id);
      expect(ids).toEqual([c.id, b.id, a.id]);
    });

    it('respects the limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await notesCreateTool.handler({ body: `n${i}` }, ctx.tc);
      }
      const result = (await notesRecentTool.handler({ limit: 2 }, ctx.tc)) as Note[];
      expect(result).toHaveLength(2);
    });

    it('skips soft-deleted notes', async () => {
      const note = (await notesCreateTool.handler(
        { body: 'doomed' },
        ctx.tc,
      )) as Note;
      await notesDeleteTool.handler({ id: note.id }, ctx.tc);

      const result = (await notesRecentTool.handler({}, ctx.tc)) as Note[];
      expect(result.find((n) => n.id === note.id)).toBeUndefined();
    });
  });
});

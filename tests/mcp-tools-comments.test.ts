import { beforeEach, describe, expect, it } from 'vitest';
import {
  notesAddCommentTool,
  notesCreateTool,
  notesDeleteCommentTool,
  notesListActivityTool,
  notesUpdateCommentTool,
} from '../src/server/tools/index.js';
import { type Ctx, setup } from './mcp-tools/helpers.js';

describe('MCP tools — comments', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  describe('notes_add_comment', () => {
    it('posts a top-level comment on a note', async () => {
      const note = (await notesCreateTool.handler({ body: '# A\n\nb' }, ctx.tc)) as Note;
      const res = (await notesAddCommentTool.handler(
        { noteId: note.id, body: 'hello' },
        ctx.tc,
      )) as { id: string; body: string; actor: string; parentId: string | null };
      expect(res.body).toBe('hello');
      expect(res.actor).toBe('mcp:test-client');
      expect(res.parentId).toBeNull();
    });

    it('creates a 1-level reply', async () => {
      const note = (await notesCreateTool.handler({ body: '# A\n\nb' }, ctx.tc)) as Note;
      const parent = (await notesAddCommentTool.handler(
        { noteId: note.id, body: 'top' },
        ctx.tc,
      )) as { id: string };
      const reply = (await notesAddCommentTool.handler(
        { noteId: note.id, body: 're: top', parentId: parent.id },
        ctx.tc,
      )) as { parentId: string | null };
      expect(reply.parentId).toBe(parent.id);
    });

    it('rejects reply-to-reply with nested_reply_rejected', async () => {
      const note = (await notesCreateTool.handler({ body: '# A\n\nb' }, ctx.tc)) as Note;
      const parent = (await notesAddCommentTool.handler(
        { noteId: note.id, body: 'top' },
        ctx.tc,
      )) as { id: string };
      const reply = (await notesAddCommentTool.handler(
        { noteId: note.id, body: 're', parentId: parent.id },
        ctx.tc,
      )) as { id: string };
      const res = await notesAddCommentTool.handler(
        { noteId: note.id, body: 're-re', parentId: reply.id },
        ctx.tc,
      );
      expect(res).toMatchObject({ error: 'nested_reply_rejected' });
    });

    it('returns note_not_found for a bogus noteId', async () => {
      const res = await notesAddCommentTool.handler(
        { noteId: 'does-not-exist', body: 'hi' },
        ctx.tc,
      );
      expect(res).toEqual({ error: 'note_not_found' });
    });
  });

  describe('notes_update_comment', () => {
    it('updates own comment body and stamps updated_at', async () => {
      const note = (await notesCreateTool.handler({ body: '# A\n\nb' }, ctx.tc)) as Note;
      const c = (await notesAddCommentTool.handler(
        { noteId: note.id, body: 'first' },
        ctx.tc,
      )) as { id: string };
      const res = (await notesUpdateCommentTool.handler(
        { commentId: c.id, body: 'edited' },
        ctx.tc,
      )) as { body: string; updatedAt: number | null };
      expect(res.body).toBe('edited');
      expect(res.updatedAt).not.toBeNull();
    });

    it('returns actor-mismatch envelope when editing another actor\'s comment', async () => {
      const note = (await notesCreateTool.handler({ body: '# A\n\nb' }, ctx.tc)) as Note;
      const c = (await notesAddCommentTool.handler(
        { noteId: note.id, body: 'by test-client' },
        ctx.tc,
      )) as { id: string };

      const otherCtx: ToolContext = { ...ctx.tc, actor: 'mcp:other-client' };
      const res = await notesUpdateCommentTool.handler(
        { commentId: c.id, body: 'hijack' },
        otherCtx,
      );
      expect(res).toMatchObject({ error: 'comment_actor_mismatch' });
    });

    it('returns mcp_comments_disabled envelope when kill-switch is off', async () => {
      const note = (await notesCreateTool.handler({ body: '# A\n\nb' }, ctx.tc)) as Note;
      const c = (await notesAddCommentTool.handler(
        { noteId: note.id, body: 'by self' },
        ctx.tc,
      )) as { id: string };

      ctx.tc.settings.setMcpCommentsEditable(false);
      const res = await notesUpdateCommentTool.handler(
        { commentId: c.id, body: 'try to edit' },
        ctx.tc,
      );
      expect(res).toMatchObject({ error: 'mcp_comments_disabled' });
    });

    it('returns comment_not_found for a bogus id', async () => {
      const res = await notesUpdateCommentTool.handler(
        { commentId: 'no-such-id', body: 'anything' },
        ctx.tc,
      );
      expect(res).toEqual({ error: 'comment_not_found' });
    });
  });

  describe('notes_delete_comment', () => {
    it('deletes own comment + writes comment_delete tombstone', async () => {
      const note = (await notesCreateTool.handler({ body: '# A\n\nb' }, ctx.tc)) as Note;
      const c = (await notesAddCommentTool.handler(
        { noteId: note.id, body: 'delete me' },
        ctx.tc,
      )) as { id: string };

      const res = (await notesDeleteCommentTool.handler(
        { commentId: c.id },
        ctx.tc,
      )) as { ok: boolean; deletedCommentId: string; noteId: string };
      expect(res.ok).toBe(true);
      expect(res.deletedCommentId).toBe(c.id);

      // Audit tombstone is present.
      const audit = ctx.tc.audit.recent(20);
      expect(audit.some((r) => r.action === 'comment_delete' && r.noteId === note.id)).toBe(true);
    });

    it('cascades replies', async () => {
      const note = (await notesCreateTool.handler({ body: '# A\n\nb' }, ctx.tc)) as Note;
      const parent = (await notesAddCommentTool.handler(
        { noteId: note.id, body: 'top' },
        ctx.tc,
      )) as { id: string };
      await notesAddCommentTool.handler(
        { noteId: note.id, body: 're1', parentId: parent.id },
        ctx.tc,
      );
      await notesAddCommentTool.handler(
        { noteId: note.id, body: 're2', parentId: parent.id },
        ctx.tc,
      );
      await notesDeleteCommentTool.handler({ commentId: parent.id }, ctx.tc);
      expect(ctx.tc.comments.count(note.id)).toBe(0);
    });

    it('returns actor-mismatch when deleting another actor\'s comment', async () => {
      const note = (await notesCreateTool.handler({ body: '# A\n\nb' }, ctx.tc)) as Note;
      const c = (await notesAddCommentTool.handler(
        { noteId: note.id, body: 'by test-client' },
        ctx.tc,
      )) as { id: string };

      const otherCtx: ToolContext = { ...ctx.tc, actor: 'mcp:other-client' };
      const res = await notesDeleteCommentTool.handler(
        { commentId: c.id },
        otherCtx,
      );
      expect(res).toMatchObject({ error: 'comment_actor_mismatch' });
      expect(ctx.tc.comments.getById(c.id)).not.toBeNull();
    });
  });

  describe('notes_list_activity', () => {
    it('returns the unified event + comment feed newest first', async () => {
      const note = (await notesCreateTool.handler({ body: '# A\n\nb' }, ctx.tc)) as Note;
      await notesAddCommentTool.handler(
        { noteId: note.id, body: 'hello' },
        ctx.tc,
      );
      const res = (await notesListActivityTool.handler(
        { noteId: note.id },
        ctx.tc,
      )) as {
        items: Array<{ kind: string; action?: string; body?: string }>;
        nextCursor: string | null;
        total: number;
      };
      expect(res.items[0]!.kind).toBe('comment');
      expect(res.items[0]!.body).toBe('hello');
      expect(res.items[1]!.kind).toBe('event');
      expect(res.items[1]!.action).toBe('create');
      expect(res.total).toBeGreaterThanOrEqual(2);
    });

    it('default limit is 10', async () => {
      const note = (await notesCreateTool.handler({ body: '# A\n\nb' }, ctx.tc)) as Note;
      // Seed 15 comments; expect only 10 in first page.
      for (let i = 0; i < 15; i++) {
        await notesAddCommentTool.handler(
          { noteId: note.id, body: `c${i}` },
          ctx.tc,
        );
      }
      const res = (await notesListActivityTool.handler(
        { noteId: note.id },
        ctx.tc,
      )) as { items: unknown[]; nextCursor: string | null };
      expect(res.items).toHaveLength(10);
      expect(res.nextCursor).not.toBeNull();
    });

    it('cursor paginates older pages', async () => {
      const note = (await notesCreateTool.handler({ body: '# A\n\nb' }, ctx.tc)) as Note;
      for (let i = 0; i < 5; i++) {
        await notesAddCommentTool.handler(
          { noteId: note.id, body: `c${i}` },
          ctx.tc,
        );
      }
      const p1 = (await notesListActivityTool.handler(
        { noteId: note.id, limit: 2 },
        ctx.tc,
      )) as { items: unknown[]; nextCursor: string | null };
      expect(p1.items).toHaveLength(2);
      const p2 = (await notesListActivityTool.handler(
        { noteId: note.id, limit: 2, cursor: p1.nextCursor! },
        ctx.tc,
      )) as { items: unknown[]; nextCursor: string | null };
      expect(p2.items).toHaveLength(2);
      expect(p2.nextCursor).not.toBe(p1.nextCursor);
    });

    it('returns note_not_found for a bogus id', async () => {
      const res = await notesListActivityTool.handler(
        { noteId: 'missing' },
        ctx.tc,
      );
      expect(res).toEqual({ error: 'note_not_found' });
    });
  });
});

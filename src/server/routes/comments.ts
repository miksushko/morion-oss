import type { Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../tools/types.js';
import { canPerform } from '../../core/permissions/check.js';
import {
  canEditComment,
  MCP_COMMENTS_DISABLED,
  COMMENT_ACTOR_MISMATCH,
} from '../../core/permissions/comments.js';
import {
  commentCreateSchema,
  commentUpdateSchema,
  decodeActivityCursor,
  encodeActivityCursor,
  NestedReplyError,
  CommentActorMismatchError,
} from '../../core/notes/comments-types.js';
import {
  countActivityForNote,
  listActivityForNote,
} from '../../core/activity/feed.js';

/**
 * Direction Q — comments + unified activity feed.
 *
 * Four endpoints:
 *   GET    /api/notes/:id/activity — UNION of audit_log events + comments,
 *                                    newest first, cursor paginated.
 *   POST   /api/notes/:id/comments — create (or reply to) a comment.
 *   PATCH  /api/comments/:id       — edit own comment body.
 *   DELETE /api/comments/:id       — delete own comment (cascades to replies)
 *                                    + writes comment_delete audit tombstone.
 *
 * UI stamps `actor='user'`; MCP surface (Q2b tools) stamps `mcp:<client>`.
 * The `mcp_comments_editable` kill-switch in `canEditComment` only fires
 * for MCP actors — user ownership of own UI posts is always preserved.
 */
export function registerCommentsRoutes(app: Hono, ctx: ToolContext): void {
  // ---------------------------------------------------------------
  // GET /api/notes/:id/activity
  // ---------------------------------------------------------------
  const activityQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(20),
    cursor: z.string().optional(),
  });

  app.get('/api/notes/:id/activity', (c) => {
    const noteId = c.req.param('id');
    const note = ctx.notes.getById(noteId);
    if (!note) return c.json({ error: 'note_not_found' }, 404);

    // Read gate on the note — one decision for the whole feed.
    if (!canPerform('read', ctx, { kind: 'note', noteId })) {
      return c.json({ error: 'mcp_access_denied' }, 403);
    }

    const query = activityQuerySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    if (!query.success) {
      return c.json({ error: 'invalid_query', detail: query.error.flatten() }, 400);
    }

    const before = query.data.cursor
      ? decodeActivityCursor(query.data.cursor) ?? undefined
      : undefined;
    const page = listActivityForNote(ctx.db, noteId, {
      limit: query.data.limit,
      before,
    });
    const total = countActivityForNote(ctx.db, noteId);
    c.header('X-Total-Count', String(total));
    return c.json({
      items: page.items,
      nextCursor: page.nextCursor ? encodeActivityCursor(page.nextCursor) : null,
      total,
    });
  });

  // ---------------------------------------------------------------
  // POST /api/notes/:id/comments  { body, parentId? }
  // ---------------------------------------------------------------
  app.post('/api/notes/:id/comments', async (c) => {
    const noteId = c.req.param('id');
    const note = ctx.notes.getById(noteId);
    if (!note) return c.json({ error: 'note_not_found' }, 404);

    if (!canPerform('update', ctx, { kind: 'note', noteId })) {
      return c.json({ error: 'mcp_access_denied' }, 403);
    }

    let input: z.infer<typeof commentCreateSchema>;
    try {
      input = commentCreateSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: 'invalid_body', detail: String(err) }, 400);
    }

    try {
      const comment = ctx.comments.create(
        noteId,
        input.body,
        ctx.actor,
        input.parentId ?? null,
      );
      if (!comment) {
        // Either noteId vanished between getById + tx (race) or parentId
        // referred to a comment on a different note.
        return c.json({ error: 'invalid_parent_or_note' }, 400);
      }
      return c.json(comment, 201);
    } catch (err) {
      if (err instanceof NestedReplyError) {
        return c.json({ error: 'nested_reply_rejected', message: err.message }, 400);
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------
  // PATCH /api/comments/:id  { body }
  // ---------------------------------------------------------------
  app.patch('/api/comments/:id', async (c) => {
    const commentId = c.req.param('id');
    const existing = ctx.comments.getById(commentId);
    if (!existing) return c.json({ error: 'comment_not_found' }, 404);

    const decision = canEditComment(existing, ctx);
    if (!decision.ok) {
      if (decision.reason === 'actor_mismatch') return c.json(COMMENT_ACTOR_MISMATCH, 403);
      if (decision.reason === 'mcp_disabled') return c.json(MCP_COMMENTS_DISABLED, 403);
      return c.json({ error: 'mcp_access_denied' }, 403);
    }

    let input: z.infer<typeof commentUpdateSchema>;
    try {
      input = commentUpdateSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: 'invalid_body', detail: String(err) }, 400);
    }

    try {
      const updated = ctx.comments.update(commentId, input.body, ctx.actor);
      if (!updated) return c.json({ error: 'comment_not_found' }, 404);
      return c.json(updated);
    } catch (err) {
      // Shouldn't happen — canEditComment already passed, but the repo
      // also enforces actor-match as defense-in-depth. Translate.
      if (err instanceof CommentActorMismatchError) {
        return c.json(COMMENT_ACTOR_MISMATCH, 403);
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------
  // DELETE /api/comments/:id
  // ---------------------------------------------------------------
  app.delete('/api/comments/:id', (c) => {
    const commentId = c.req.param('id');
    const existing = ctx.comments.getById(commentId);
    if (!existing) return c.json({ error: 'comment_not_found' }, 404);

    const decision = canEditComment(existing, ctx);
    if (!decision.ok) {
      if (decision.reason === 'actor_mismatch') return c.json(COMMENT_ACTOR_MISMATCH, 403);
      if (decision.reason === 'mcp_disabled') return c.json(MCP_COMMENTS_DISABLED, 403);
      return c.json({ error: 'mcp_access_denied' }, 403);
    }

    // Delete + tombstone in a single transaction so a crash between them
    // can't leave a comment gone without its audit row. Tombstone uses
    // the PARENT note's id (comments are scoped to notes) — activity
    // feed shows «User deleted a comment» anchored to the right note.
    const tx = ctx.db.transaction(() => {
      try {
        ctx.comments.delete(commentId, ctx.actor);
      } catch (err) {
        if (err instanceof CommentActorMismatchError) {
          // Should have been caught by canEditComment above; re-throw as
          // a marker we can translate outside the tx.
          throw err;
        }
        throw err;
      }
      ctx.audit.record({
        noteId: existing.noteId,
        action: 'comment_delete',
        actor: ctx.actor,
      });
    });
    try {
      tx();
    } catch (err) {
      if (err instanceof CommentActorMismatchError) {
        return c.json(COMMENT_ACTOR_MISMATCH, 403);
      }
      throw err;
    }
    return c.json({ ok: true });
  });
}

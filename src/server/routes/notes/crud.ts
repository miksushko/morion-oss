import type { Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../../tools/types.js';
import { scheduleReindex, unlinkAttachmentFiles } from '../../bootstrap/helpers.js';
import {
  checkActiveRunLock,
  validateTicketWorkflowAssignment,
} from '../../features/auto-code-factory/ticket-workflow-validation.js';

/**
 * Single-note CRUD — read by id + create + update + soft-delete +
 * permanent purge + restore.
 *
 * Title is derived from the first line of body by the repo — the
 * web UI never sends it. The shared `noteCreateSchema` still
 * accepts `title` for MCP backwards compat, but the HTTP layer
 * strips it so UI code can't accidentally set a title that drifts
 * from the body.
 *
 * Routes (registered in this order):
 *   - `GET    /api/notes/:id`         — read
 *   - `POST   /api/notes`             — create
 *   - `PATCH  /api/notes/:id`         — update
 *   - `DELETE /api/notes/:id`         — soft delete (trash)
 *   - `DELETE /api/notes/:id/purge`   — hard delete (must be in trash)
 *   - `POST   /api/notes/:id/restore` — restore from trash
 *
 * Extracted from src/server/routes/notes.ts during the 2026-05-16
 * split (Morion ticket 01KRR8J8ED8E8QE37W3QRBP8G7).
 */
export function registerNotesCrudRoutes(app: Hono, ctx: ToolContext): void {
  const actor = ctx.actor;

  app.get('/api/notes/:id', (c) => {
    const note = ctx.notes.getById(c.req.param('id'));
    if (!note) return c.json({ error: 'not found' }, 404);
    return c.json(note);
  });

  const httpNoteCreateSchema = z.object({
    body: z.string().default(''),
    folderId: z.string().nullish(),
    tags: z.array(z.string().min(1).max(64)).optional(),
    pinned: z.boolean().optional(),
    // Direction N — UI creates a kanban card by posting status='note'
    // (or explicitly a different column). The repo normalises and
    // computes position when the status is a manual-order column.
    status: z
      .enum(['note', 'backlog', 'todo', 'doing', 'review', 'done'])
      .optional(),
    position: z.number().nullish(),
  });

  app.post('/api/notes', async (c) => {
    const body = await c.req.json();
    const input = httpNoteCreateSchema.parse(body);
    const note = ctx.notes.create({ ...input, source: 'user' }, actor);
    scheduleReindex(ctx, note);
    return c.json(note, 201);
  });

  // Same rationale as httpNoteCreateSchema — title is repo-derived,
  // the UI only patches body/folder/tags/pinned. Direction N adds
  // optional status/position so list-view edits of kanban-folder
  // notes still work. `workflowId` is the per-ticket Auto-code
  // override (ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE) — built-in template
  // id or `workflows` row ULID; null clears the override.
  const httpNoteUpdateSchema = z.object({
    body: z.string().optional(),
    folderId: z.string().nullish(),
    tags: z.array(z.string().min(1).max(64)).optional(),
    pinned: z.boolean().optional(),
    status: z
      .enum(['note', 'backlog', 'todo', 'doing', 'review', 'done'])
      .optional(),
    position: z.number().nullish(),
    workflowId: z.string().nullish(),
  });

  app.patch('/api/notes/:id', async (c) => {
    const body = await c.req.json();
    const input = httpNoteUpdateSchema.parse(body);

    const noteId = c.req.param('id');
    const existingNote = ctx.notes.getById(noteId);
    if (existingNote) {
      const targetFolderId =
        input.folderId !== undefined ? input.folderId : existingNote.folderId;

      // Per-ticket Auto-code workflow override (ticket
      // 01KRWQPDKQ2RZMDBJZ5KN0B7YE). The patched workflowId must
      // resolve (built-in template OR `workflows` row owned by the
      // ticket's folder) AND the ticket must NOT have an in-flight
      // run — workflow swaps mid-execution would mismatch the
      // immutable graph snapshot already loaded by the runner.
      if (input.workflowId !== undefined) {
        const ticketFolderId = targetFolderId;
        const v = validateTicketWorkflowAssignment(
          ctx.db,
          ticketFolderId,
          input.workflowId ?? null,
        );
        if (!v.ok) return c.json(v.error, 422);
        const lock = checkActiveRunLock(ctx.db, ticketFolderId, noteId);
        if (lock) return c.json(lock, 409);
      }
    }

    const note = ctx.notes.update(noteId, input, actor);
    if (!note) return c.json({ error: 'not found' }, 404);
    scheduleReindex(ctx, note);
    return c.json(note);
  });

  app.delete('/api/notes/:id', (c) => {
    const id = c.req.param('id');
    const ok = ctx.notes.delete(id, actor);
    // Soft-delete: drop the row from the vector index so it stops
    // surfacing in semantic search. The FTS sync trigger handles the
    // keyword side automatically when `deleted_at` flips to non-null.
    // The note can still be brought back via
    // `POST /api/notes/:id/restore` for the next 7 days.
    if (ok) ctx.indexer.remove(id);
    return c.json({ ok });
  });

  // Permanent (hard) delete of a single trashed note. Refuses live
  // notes — the only way to permanently remove a note is via the
  // trash workflow, matching every desktop trash UI in the world.
  app.delete('/api/notes/:id/purge', (c) => {
    const id = c.req.param('id');
    // Collect attachment paths before the cascade wipes the rows.
    const attachmentPaths = ctx.attachments.pathsForNotes([id]);
    const ok = ctx.notes.purge(id, actor);
    if (!ok) return c.json({ error: 'not found or not in trash' }, 404);
    ctx.indexer.remove(id);
    unlinkAttachmentFiles(attachmentPaths);
    return c.json({ ok });
  });

  app.post('/api/notes/:id/restore', (c) => {
    const note = ctx.notes.restore(c.req.param('id'), actor);
    if (!note) return c.json({ error: 'not found' }, 404);
    // Re-embed so the restored note shows up in semantic search
    // again. FTS comes back automatically via the notes_au trigger
    // when `deleted_at` flips to NULL. Fire-and-forget.
    scheduleReindex(ctx, note);
    return c.json(note);
  });
}

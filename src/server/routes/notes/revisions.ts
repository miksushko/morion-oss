import type { Hono } from 'hono';
import type { ToolContext } from '../../tools/types.js';
import { scheduleReindex } from '../../bootstrap/helpers.js';

/**
 * Revision (version history) routes — list / snapshot / restore.
 *
 * MCP `notes_update` / `notes_append` snapshot inside the tool
 * handler. HTTP PATCH does NOT auto-snapshot — editor debounces on
 * every keystroke and that would flood the table. The UI calls
 * `POST /api/notes/:id/revisions` explicitly on navigate-away.
 *
 * Routes:
 *   - `GET  /api/notes/:id/revisions`                   — list
 *   - `POST /api/notes/:id/revisions`                   — snapshot
 *   - `POST /api/notes/:id/revisions/:revId/restore`    — restore
 *
 * Extracted from src/server/routes/notes.ts during the 2026-05-16
 * split (Morion ticket 01KRR8J8ED8E8QE37W3QRBP8G7).
 */
export function registerNotesRevisionsRoutes(app: Hono, ctx: ToolContext): void {
  const actor = ctx.actor;

  app.get('/api/notes/:id/revisions', (c) => {
    const id = c.req.param('id');
    // Don't expose history for notes that were never created. Live +
    // trashed notes both work — the UI footer button shows up in both
    // modes.
    const note = ctx.notes.getById(id, { includeTrashed: true });
    if (!note) return c.json({ error: 'not found' }, 404);
    return c.json(ctx.revisions.listForNote(id));
  });

  app.post('/api/notes/:id/revisions', (c) => {
    const id = c.req.param('id');
    // Only live notes can be snapshotted — trashed notes can't be
    // edited, so there's nothing new to capture.
    const note = ctx.notes.getById(id);
    if (!note) return c.json({ error: 'not found' }, 404);
    const rev = ctx.revisions.create(id, actor);
    if (!rev) return c.json({ error: 'snapshot failed' }, 500);
    return c.json(rev, 201);
  });

  app.post('/api/notes/:id/revisions/:revId/restore', async (c) => {
    const id = c.req.param('id');
    const revId = c.req.param('revId');

    // Refuse to operate on trashed notes — restoring history into a
    // deleted note would silently un-trash it, which is surprising.
    // The user must restore-from-trash first.
    const live = ctx.notes.getById(id);
    if (!live) return c.json({ error: 'not found' }, 404);

    const revision = ctx.revisions.getById(revId);
    if (!revision || revision.noteId !== id) {
      return c.json({ error: 'revision not found' }, 404);
    }

    // Tag rows are referenced by id in the revision blob (so a tag
    // rename keeps the historical label correct). Missing tags /
    // deleted folders are silently skipped — restore is best-effort,
    // not a full database time-machine. Tag/folder lookups happen
    // before the transaction so the inside of the tx is just the two
    // writes.
    const tagNames: string[] = [];
    for (const tagId of revision.tagIds) {
      const tag = ctx.tags.getById(tagId);
      if (tag) tagNames.push(tag.name);
    }
    const folderId = revision.folderId
      ? (ctx.folders.getById(revision.folderId) ? revision.folderId : null)
      : null;

    // Snapshot current state + restore inside a single outer
    // transaction so a crash between them can't orphan the backup
    // revision (audit N12, 2026-04-16). Repo dedup on the snapshot
    // means restoring twice in a row to the same revision doesn't
    // pollute history.
    const updated = ctx.db.transaction(() => {
      ctx.revisions.create(id, actor);
      return ctx.notes.update(
        id,
        {
          title: revision.title,
          body: revision.body,
          folderId,
          tags: tagNames,
        },
        actor,
      );
    })();
    if (!updated) return c.json({ error: 'restore failed' }, 500);
    scheduleReindex(ctx, updated);
    return c.json(updated);
  });
}

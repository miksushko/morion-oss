import type { Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../tools/types.js';
import { ConciergeFolderSettingsRepository } from '../../core/concierge/folder-settings-repository.js';
import { AUTO_CODE_ACTOR } from '../../core/auto-code/actor-constants.js';
import { buildAutoCodeDispatcher } from '../features/auto-code-factory/index.js';

/**
 * Kanban (Direction N) endpoints for the UI. Functionally thin wrappers
 * over `NotesRepository` + `FoldersRepository` — the MCP tool layer
 * (`tasks_*`) uses the same repo methods. No audit_log parallelism: the
 * UI's actor is `'user'` while MCP tools stamp `'mcp:<client>'`, so a
 * `status_change` row reliably says who flipped the card.
 */
export function registerKanbanRoutes(app: Hono, ctx: ToolContext): void {
  const actor = ctx.actor;

  const folderViewModeSchema = z.object({
    viewMode: z.enum(['list', 'kanban']),
  });

  app.patch('/api/folders/:id/view-mode', async (c) => {
    const input = folderViewModeSchema.parse(await c.req.json());
    const folder = ctx.folders.setViewMode(c.req.param('id'), input.viewMode);
    if (!folder) return c.json({ error: 'not found' }, 404);
    return c.json(folder);
  });

  // Board read: return the whole kanban for a folder in one request,
  // grouped by status so the UI doesn't re-walk the array 6 times.
  // Empty arrays for columns with no cards — consumers can rely on
  // all six keys being present.
  app.get('/api/folders/:id/kanban', (c) => {
    const folder = ctx.folders.getById(c.req.param('id'));
    if (!folder) return c.json({ error: 'not found' }, 404);
    if (folder.viewMode !== 'kanban') {
      return c.json({ error: 'folder_not_kanban' }, 409);
    }
    const notes = ctx.notes.listKanban({ folderId: folder.id, limit: 500 });
    // Direction Q — batched comment count per card so the KanbanView
    // can render the "💬 3" badge without an extra request per card
    // (which would be O(columns × cards) GETs on a dense board).
    // `countForNotes` is a single GROUP BY under an existing index.
    const commentCounts = ctx.comments.countForNotes(notes.map((n) => n.id));
    const notesWithCounts = notes.map((n) => ({
      ...n,
      commentCount: commentCounts.get(n.id) ?? 0,
    }));
    type NoteWithCount = (typeof notesWithCounts)[number];
    const byStatus: Record<string, NoteWithCount[]> = {
      note: [],
      backlog: [],
      todo: [],
      doing: [],
      review: [],
      done: [],
    };
    for (const n of notesWithCounts) {
      (byStatus[n.status] ?? (byStatus[n.status] = [])).push(n);
    }
    return c.json({ folder, columns: byStatus });
  });

  // Drag-and-drop endpoint — one tool for both "change column" and
  // "reorder inside column". afterNoteId=null means top-of-column.
  //
  // Direction Q Phase Q4: accept optional `message`. HTTP calls stamp
  // actor='user' and NEVER enforce the "require status comment" setting
  // — that toggle only gates MCP actors. Per spec: users click their
  // own drag-and-drop moves, they know what they did.
  const kanbanMoveSchema = z.object({
    status: z.enum(['note', 'backlog', 'todo', 'doing', 'review', 'done']),
    afterNoteId: z.string().nullable().optional(),
    message: z.string().max(10_000).optional(),
  });

  app.post('/api/notes/:id/kanban-move', async (c) => {
    const input = kanbanMoveSchema.parse(await c.req.json());
    const noteId = c.req.param('id');
    const trimmedMessage = input.message?.trim() ?? '';
    // Atomic status-change + auto-comment in one tx, matching the MCP
    // tool semantics. Caller gets back the moved note (not the comment).
    const result = ctx.db.transaction(() => {
      const note = ctx.notes.moveToKanban(
        noteId,
        input.status,
        input.afterNoteId ?? null,
        actor,
      );
      if (!note) return null;
      if (trimmedMessage !== '') {
        const body = `Moved to ${input.status}: ${trimmedMessage}`;
        ctx.comments.create(noteId, body, actor, null);
      }
      return note;
    })();
    if (!result) return c.json({ error: 'not found' }, 404);

    // Auto-code drift cancel (sub-ticket 01KQEEC6B0D7EE7E3DY45DSP9K
    // follow-up). When the user manually drags a kanban card out of
    // a state where the agent is mid-fix, the in-flight queue row
    // becomes stale — the agent is editing a worktree that the user
    // has already moved past. Cancel + SIGTERM + worktree cleanup so
    // the loop matches the user's intent.
    //
    // Skip the cancel when:
    //   - the move came from `mcp:auto-code` itself (we approve →
    //     done, escalate → backlog, etc; cancelling would race with
    //     our own state machine and risk killing a process we just
    //     finished cleanly)
    //   - the move LANDS in `todo` (that's the entry state — agent
    //     starts work there; staying in todo is fine)
    //   - there's no in-flight row (no-op)
    //
    // The auto-code-paused tag stays as a separate signal — re-
    // dragging a paused card to `todo` would re-enqueue from the
    // orchestrator subscriber once that ships.
    if (actor !== AUTO_CODE_ACTOR && result.folderId) {
      const folderSettings = new ConciergeFolderSettingsRepository(ctx.db);
      const settings = folderSettings.getOrDefault(result.folderId);
      if (settings.autoCodeEnabled && settings.linkedRepoPath) {
        if (input.status !== 'todo') {
          // OUTBOUND from agent-active state. Cancel + kill any
          // in-flight work for this task across BOTH engines (legacy
          // mo_agent_queue + new workflow_runs) so toggling
          // `auto_code.use_workflow_runner` mid-flight doesn't leak
          // an in-progress agent that the user has already moved
          // past on the kanban.
          try {
            const dispatcher = await buildAutoCodeDispatcher(ctx);
            await dispatcher.cancelTicket(
              result.folderId,
              noteId,
              `kanban-move:${actor}:${input.status}`,
            );
          } catch (err) {
            // Cancel failure is logged but doesn't roll back the
            // user's move — they wanted the card moved, period.
            console.error('[auto-code] kanban-move cancel failed:', err);
          }
        } else {
          // INBOUND to `todo`. Auto-enqueue subscriber: this is the
          // user-driven trigger per umbrella spec step 4 ("User
          // двигает карточку в `todo`"). Build a per-request
          // orchestrator + call enqueueTask. Errors are non-fatal
          // (the move already landed; bad enqueue just means agent
          // won't start, user can retry by moving out + back in).
          //
          // Done as fire-and-forget on the response path so the user's
          // PATCH returns immediately — preflight + worktree setup
          // (~1-2s) shouldn't block the kanban drag's return.
          const dispatcherPromise = buildAutoCodeDispatcher(ctx);
          const folderId = result.folderId;
          dispatcherPromise
            .then(async (dispatcher) => {
              try {
                await dispatcher.enqueueTicket(noteId, folderId);
                // Workflow-runner is self-driving (runner.start
                // dispatches asynchronously) — no explicit kick needed.
                // The legacy auto-tick path was retired with the legacy
                // orchestrator (ticket 01KRB0W7CV1PF48YD8FF6J14DG).
              } catch (err) {
                console.error(
                  '[auto-code] auto-enqueue on kanban-move failed:',
                  err,
                );
              }
            })
            .catch((err) => {
              console.error(
                '[auto-code] orchestrator factory failed on kanban-move:',
                err,
              );
            });
        }
      }
    }

    return c.json(result);
  });

  // Status-change history for the card popover. Reuses the audit
  // log's status_change rows — one DB table, one source of truth.
  app.get('/api/notes/:id/status-history', (c) => {
    const id = c.req.param('id');
    const note = ctx.notes.getById(id, { includeTrashed: true });
    if (!note) return c.json({ error: 'not found' }, 404);
    const limitParam = c.req.query('limit');
    const limit = limitParam ? Math.min(200, Math.max(1, Number(limitParam))) : 50;
    return c.json(ctx.audit.statusHistory(id, limit));
  });
}

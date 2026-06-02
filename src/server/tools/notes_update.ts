import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import {
  checkActiveRunLock,
  validateTicketWorkflowAssignment,
} from '../features/auto-code-factory/ticket-workflow-validation.js';

export const notesUpdateTool = defineTool({
  name: 'notes_update',
  description:
    'Partially update a note by id. Only provided fields are changed. Returns the updated note, or null if it does not exist. The title is derived from the first line of body — update body to change the title. Legacy: passing title will merge it into body. Providing `tags` REPLACES the existing tag set. `workflowId` assigns a per-ticket Auto-code workflow (use `workflows_list` to discover ids); the ticket must NOT be in flight and the workflow must belong to the ticket\'s folder (or be a built-in template id like "default").',
  category: 'update',
  inputShape: {
    id: z.string(),
    title: z.string().max(500).optional().describe('Legacy. Omit this — edit the first line of body to change the title. If provided, it will be merged into body.'),
    body: z.string().optional().describe('Markdown body. The first line becomes the note title.'),
    folderId: z.string().nullable().optional(),
    tags: z
      .array(z.string().min(1).max(64))
      .optional()
      .describe(
        "REPLACES the existing tag set when provided. WORKSPACE-WIDE categorial labels — call `tags_list` first and REUSE existing names rather than coining synonyms. Use ONLY for: Environment (mobile / desktop / web / dev / staging / production / ci), OS or install target (windows / linux / macos / ios / android / docker / appimage / deb / dmg), Code area (backend / frontend / ui / ux / cli / mcp / db / api / infra / build / release), or Ticket type (bug / feature / enhancement / story / epic / note / data-issue / refactor / spike / chore). DO NOT tag: status (kanban already encodes that), module / subsystem / feature name (Mo topics handle that — `auto-code`, `mo-chat`, `kanban-ui` are forbidden), person / agent, or free-text descriptors (`urgent`, `important`, `wip`). When nothing in the four categories clearly fits, omit `tags` entirely — a note with zero tags is fine, a note with an invented synonym is workspace pollution. Lowercase + dash-separated.",
      ),
    pinned: z.boolean().optional(),
    workflowId: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Per-ticket Auto-code workflow override. Either a built-in template id (e.g. "default") or a `workflows` row ULID owned by the ticket\'s folder. Pass null to clear the override (ticket falls back to the folder default). Use `workflows_list({folderId})` to enumerate options. Returns `workflow_locked_during_run` (HTTP 409) when the ticket has an in-flight run — drag the card out of `todo`/`doing` first.',
      ),
  },
  async handler(input, ctx) {
    const { id, ...patch } = input;
    if (!canPerform('update', ctx, { kind: 'note', noteId: id })) return ACCESS_DENIED;
    // If the patch moves the note to a new folder, the destination folder
    // also has to allow create-style writes (otherwise an LLM could move
    // a note INTO a write-protected folder and then mutate it freely).
    if (patch.folderId !== undefined) {
      if (!canPerform('create', ctx, { kind: 'newNote', folderId: patch.folderId ?? null })) {
        return ACCESS_DENIED;
      }
    }

    // Per-ticket Auto-code workflow override (ticket
    // 01KRWQPDKQ2RZMDBJZ5KN0B7YE). Validate that the supplied id
    // resolves to a built-in template OR a `workflows` row owned
    // by the ticket's folder, AND that the ticket has no in-flight
    // run (matching the HTTP route's contract).
    if (patch.workflowId !== undefined) {
      const existing = ctx.notes.getById(id);
      if (!existing) return null;
      const targetFolderId =
        patch.folderId !== undefined ? patch.folderId ?? null : existing.folderId;
      const v = validateTicketWorkflowAssignment(
        ctx.db,
        targetFolderId,
        patch.workflowId ?? null,
      );
      if (!v.ok) return v.error;
      const lock = checkActiveRunLock(ctx.db, targetFolderId, id);
      if (lock) return lock;
    }
    // Snapshot the pre-mutation state into the version history. The repo
    // dedupes consecutive identical snapshots, so a tool call that ends up
    // being a no-op patch (e.g. `notes_update` with the same body) doesn't
    // pollute the history. The snapshot has to happen before the mutation
    // so the resulting revision represents the state the user can roll back
    // TO, not the state the LLM just wrote.
    //
    // Wrap snapshot + mutation in a single outer SQLite transaction
    // (better-sqlite3 nested txs become savepoints) so a crash between the
    // two can't orphan a revision with no corresponding update — finding
    // N12, 2026-04-16. Indexer.reindex is async + touches an independent
    // index, so it runs after the tx commits.
    const updated = ctx.db.transaction(() => {
      ctx.revisions.create(id, ctx.actor);
      return ctx.notes.update(id, patch, ctx.actor);
    })();
    if (updated) await ctx.indexer.reindex(updated);
    return updated;
  },
});

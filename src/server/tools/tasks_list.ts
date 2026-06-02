import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED, filterReadable } from '../../core/permissions/check.js';
import { NOTE_STATUSES } from '../../core/notes/types.js';

export const tasksListTool = defineTool({
  name: 'tasks_list',
  description:
    'Read kanban tasks from a folder. Returns notes ordered by column (note, backlog, todo, doing, review, done) and then by position within each manual-order column. The folder must be in kanban mode; list-folders return an empty array with a hint. Optional filters narrow to a single column (status) or a time window (since/until, both in ms epoch, reuse updated_at). No due_date field exists — time filters are the only chronological lens.',
  category: 'read',
  inputShape: {
    folderId: z.string().describe('The folder to read from. Must be a kanban-mode folder.'),
    status: z
      .enum(NOTE_STATUSES)
      .optional()
      .describe('Narrow to a single column. Omit to read the whole board.'),
    since: z
      .number()
      .int()
      .optional()
      .describe('Include only tasks with updated_at >= this epoch-ms. Optional.'),
    until: z
      .number()
      .int()
      .optional()
      .describe('Include only tasks with updated_at <= this epoch-ms. Optional.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(200)
      .describe('Cap on returned rows. Default 200, max 500.'),
  },
  async handler(input, ctx) {
    // Gate against folder visibility first so an LLM without read access
    // can't enumerate an entire board by walking the status filter.
    if (!canPerform('read', ctx, { kind: 'folder', folderId: input.folderId })) {
      return ACCESS_DENIED;
    }

    const folder = ctx.folders.getById(input.folderId);
    if (!folder) {
      return { error: 'folder_not_found', message: `No folder with id ${input.folderId}.` };
    }
    if (folder.viewMode !== 'kanban') {
      return {
        error: 'folder_not_kanban',
        message: `Folder "${folder.name}" is in list mode. Switch it to kanban via folders_set_view_mode, or read notes with notes_list.`,
        tasks: [],
      };
    }

    const notes = ctx.notes.listKanban({
      folderId: input.folderId,
      status: input.status,
      since: input.since,
      until: input.until,
      limit: input.limit,
    });

    // Per-note visibility gate — applies note-level mcp_visible overrides.
    const visible = filterReadable(notes, ctx);
    return {
      folder: { id: folder.id, name: folder.name, viewMode: folder.viewMode },
      tasks: visible,
    };
  },
});

import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import { FOLDER_VIEW_MODES } from '../../core/notes/types.js';

export const foldersSetViewModeTool = defineTool({
  name: 'folders_set_view_mode',
  description:
    "Switch a folder between 'list' (default, classic note list) and 'kanban' (6-column board: note / backlog / todo / doing / review / done). The flip is data-preserving: every note keeps its status and position across flips, so kanban→list→kanban restores the original board without any migration. Use this to convert a project folder into a work queue that MCP agents (and the user) can move cards through. Requires update permission on the folder.",
  category: 'update',
  // Reversible, data-preserving. A kanban→list flip just hides the columns;
  // no rows are deleted and re-flipping restores everything.
  annotations: { destructiveHint: false },
  inputShape: {
    folderId: z.string().describe('The folder to reconfigure.'),
    mode: z.enum(FOLDER_VIEW_MODES).describe("Either 'list' or 'kanban'."),
  },
  async handler(input, ctx) {
    if (!canPerform('update', ctx, { kind: 'folder', folderId: input.folderId })) {
      return ACCESS_DENIED;
    }

    const folder = ctx.folders.getById(input.folderId);
    if (!folder) {
      return { error: 'folder_not_found', message: `No folder with id ${input.folderId}.` };
    }

    const updated = ctx.folders.setViewMode(input.folderId, input.mode);
    return updated;
  },
});

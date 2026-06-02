import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED, filterReadable } from '../../core/permissions/check.js';

export const foldersMoveTool = defineTool({
  name: 'folders_move',
  description:
    'Move a folder one slot earlier or later within its parent ordering. Returns the new folder list in order. Returns null if the folder does not exist or is already at the boundary in the requested direction.',
  category: 'update',
  inputShape: {
    id: z.string().min(1).describe('Folder id to move'),
    direction: z.enum(['up', 'down']).describe('"up" moves towards the top of the sidebar, "down" towards the bottom'),
  },
  async handler(input, ctx) {
    if (!canPerform('update', ctx, { kind: 'folder', folderId: input.id })) {
      return ACCESS_DENIED;
    }
    const ok = ctx.folders.move(input.id, input.direction === 'up' ? -1 : 1);
    if (!ok) return null;
    // Post-filter the returned list so an MCP caller that shuffled a folder
    // doesn't incidentally learn about hidden siblings via the response.
    return filterReadable(ctx.folders.list(), ctx);
  },
});

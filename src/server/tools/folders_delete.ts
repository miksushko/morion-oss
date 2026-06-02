import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

export const foldersDeleteTool = defineTool({
  name: 'folders_delete',
  description:
    'Delete a folder by id. Notes in the deleted folder are unfiled (their folderId becomes null) — they are NOT deleted. Returns true on success.',
  category: 'delete',
  inputShape: {
    id: z.string().describe('Folder id'),
  },
  async handler(input, ctx) {
    if (!canPerform('delete', ctx, { kind: 'folder', folderId: input.id })) {
      return ACCESS_DENIED;
    }
    const ok = ctx.folders.delete(input.id);
    return { ok };
  },
});

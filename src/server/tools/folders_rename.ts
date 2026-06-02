import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

export const foldersRenameTool = defineTool({
  name: 'folders_rename',
  description:
    'Rename a folder by id. Returns the updated folder, or null if it does not exist.',
  category: 'update',
  // Rename is trivially reversible — override the "update → destructive"
  // default so clients don't flash a scary confirmation prompt.
  annotations: { destructiveHint: false },
  inputShape: {
    id: z.string().describe('Folder id'),
    name: z.string().min(1).max(200).describe('New folder name'),
  },
  async handler(input, ctx) {
    if (!canPerform('update', ctx, { kind: 'folder', folderId: input.id })) {
      return ACCESS_DENIED;
    }
    const ok = ctx.folders.rename(input.id, input.name);
    if (!ok) return null;
    return ctx.folders.getById(input.id);
  },
});

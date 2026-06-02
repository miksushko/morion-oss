import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

export const foldersCreateTool = defineTool({
  name: 'folders_create',
  description:
    'Create a new folder. Returns the folder including its id. Use this when the user asks to organize notes into a new project / category / area, or before placing a created note into a brand new folder. Folder names should be short and descriptive (e.g. "work", "personal", "project-alpha").',
  category: 'create',
  inputShape: {
    name: z.string().min(1).max(200).describe('Folder name'),
    parentId: z
      .string()
      .nullable()
      .optional()
      .describe('Optional parent folder id for nested folders. Null or omitted creates a top-level folder.'),
  },
  async handler(input, ctx) {
    // Top-level folder creation has no permission target (permissions are
    // defined at the folder level, not globally), so only gate nested
    // creation: the parent must allow `create`.
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      if (!canPerform('create', ctx, { kind: 'folder', folderId: parentId })) {
        return ACCESS_DENIED;
      }
    }
    return ctx.folders.create(input.name, parentId);
  },
});

import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED, filterReadable } from '../../core/permissions/check.js';

export const foldersReorderTool = defineTool({
  name: 'folders_reorder',
  description:
    'Reorder folders by passing the full ordered list of folder ids. The position of folder orderedIds[i] becomes i. Folders missing from the array keep their existing position. Returns the new folder list in order.',
  category: 'update',
  // Reorder only changes the `position` column. Reversible, content
  // untouched — not destructive.
  annotations: { destructiveHint: false },
  inputShape: {
    orderedIds: z.array(z.string().min(1)).describe('Folder ids in the desired order, top to bottom'),
  },
  async handler(input, ctx) {
    // Every folder the caller is reshuffling must be update-permitted.
    // If any folder is restricted, deny the whole operation — a partial
    // reorder that only touches some folders would leave the sidebar in
    // an ambiguous state that's harder to debug than a clean refusal.
    for (const id of input.orderedIds) {
      if (!canPerform('update', ctx, { kind: 'folder', folderId: id })) {
        return ACCESS_DENIED;
      }
    }
    ctx.folders.reorder(input.orderedIds);
    return filterReadable(ctx.folders.list(), ctx);
  },
});

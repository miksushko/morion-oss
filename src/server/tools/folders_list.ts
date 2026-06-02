import { defineTool } from './types.js';
import { filterReadable } from '../../core/permissions/check.js';

export const foldersListTool = defineTool({
  name: 'folders_list',
  description: 'List every folder in the notebook, ordered by position and name. Use this to orient yourself before filtering notes_list or notes_search by folderId.',
  category: 'read',
  inputShape: {},
  async handler(_input, ctx) {
    return filterReadable(ctx.folders.list(), ctx);
  },
});

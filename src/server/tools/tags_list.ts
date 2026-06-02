import { defineTool } from './types.js';

export const tagsListTool = defineTool({
  name: 'tags_list',
  description: 'List every tag in the notebook, alphabetically. Use this to find the exact tag name before filtering notes_list by tag.',
  category: 'read',
  inputShape: {},
  async handler(_input, ctx) {
    return ctx.tags.list();
  },
});

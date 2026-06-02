import { z } from 'zod';
import { defineTool } from './types.js';

const colorSchema = z
  .string()
  .regex(/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'invalid hex color')
  .nullable();

export const tagsUpdateTool = defineTool({
  name: 'tags_update',
  description:
    'Rename or recolor a tag by id. At least one of `name` or `color` must be provided. Returns the updated tag, or null if the tag does not exist.',
  category: 'update',
  inputShape: {
    id: z.string().describe('Tag id'),
    name: z.string().min(1).max(64).optional().describe('New tag name'),
    color: colorSchema
      .optional()
      .describe('New hex color (e.g. "#ff5733"). Pass null to clear the color.'),
  },
  async handler(input, ctx) {
    const patch: { name?: string; color?: string | null } = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.color !== undefined) patch.color = input.color;
    return ctx.tags.update(input.id, patch);
  },
});

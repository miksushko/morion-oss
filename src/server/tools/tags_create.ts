import { z } from 'zod';
import { defineTool } from './types.js';

const colorSchema = z
  .string()
  .regex(/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'invalid hex color')
  .nullable();

export const tagsCreateTool = defineTool({
  name: 'tags_create',
  description:
    'Create a new tag with an optional hex color. Use this only when the user explicitly asks to create a tag — for everyday note tagging, just pass tag names to notes_create / notes_update and they are created on the fly. Throws if a tag with the same name already exists.',
  category: 'create',
  inputShape: {
    name: z.string().min(1).max(64).describe('Tag name'),
    color: colorSchema
      .optional()
      .describe('Optional hex color (e.g. "#ff5733"). Null or omitted means no color.'),
  },
  async handler(input, ctx) {
    return ctx.tags.create(input.name, input.color ?? null);
  },
});

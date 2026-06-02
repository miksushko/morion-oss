import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';

export const notesCreateTool = defineTool({
  name: 'notes_create',
  description:
    'Create a new note. Returns the created note including its id. Use this whenever the user asks to remember, jot down, log, or save something. The title is derived from the first line of body — keep it concise (under 100 chars) and put the rest after a blank line. Legacy: if you pass title separately, it will be prepended to body.',
  category: 'create',
  inputShape: {
    title: z.string().max(500).optional().describe('Legacy. Omit this — write the title as the first line of body instead. If provided, it will be prepended to body.'),
    body: z.string().default('').describe('Markdown body. The first line becomes the note title.'),
    folderId: z
      .string()
      .nullable()
      .optional()
      .describe('Optional folder id. Null or omitted places the note in the root.'),
    tags: z
      .array(z.string().min(1).max(64))
      .optional()
      .describe(
        "Optional tag names. WORKSPACE-WIDE categorial labels — call `tags_list` first and REUSE existing names rather than coining synonyms. Use ONLY for: Environment (mobile / desktop / web / dev / staging / production / ci), OS or install target (windows / linux / macos / ios / android / docker / appimage / deb / dmg), Code area (backend / frontend / ui / ux / cli / mcp / db / api / infra / build / release), or Ticket type (bug / feature / enhancement / story / epic / note / data-issue / refactor / spike / chore). DO NOT tag: status (kanban already encodes that), module / subsystem / feature name (Mo topics handle that — `auto-code`, `mo-chat`, `kanban-ui` are forbidden), person / agent, or free-text descriptors (`urgent`, `important`, `wip`). When nothing in the four categories clearly fits, add NO tag — a note with zero tags is fine, a note with an invented synonym is workspace pollution. Lowercase + dash-separated.",
      ),
    pinned: z.boolean().optional(),
  },
  async handler(input, ctx) {
    const folderId = input.folderId ?? null;
    if (!canPerform('create', ctx, { kind: 'newNote', folderId })) return ACCESS_DENIED;
    const note = ctx.notes.create(
      {
        title: input.title,
        body: input.body ?? '',
        folderId: input.folderId ?? null,
        tags: input.tags,
        pinned: input.pinned,
        source: ctx.actor.startsWith('mcp:') ? ctx.actor : 'user',
      },
      ctx.actor,
    );
    await ctx.indexer.reindex(note);
    return note;
  },
});

import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform } from '../../core/permissions/check.js';

export const auditRecentTool = defineTool({
  name: 'audit_recent',
  description:
    'Last N rows from the audit log, joined with note titles. Lets a user (or another assistant) answer "what did Claude write to my notes today?" without opening the SQLite file by hand. Optional actor filter narrows to a single MCP client (e.g. mcp:claude-ai, mcp:cursor).',
  category: 'read',
  inputShape: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Maximum number of audit rows to return. Default 20, max 200.'),
    actor: z
      .string()
      .optional()
      .describe('Optional actor filter, e.g. "mcp:claude-ai" or "user".'),
  },
  async handler(input, ctx) {
    const limit = input.limit ?? 20;
    const rows = ctx.audit.recent(limit, input.actor);
    // Hide audit entries for notes the caller has no read access to
    // (finding N4, 2026-04-16). Otherwise hidden-folder existence leaks
    // through the audit — an LLM that can't see a note can still observe
    // its status changes, edits, and actor. Orphan rows (`noteId === null`,
    // e.g. future folder-level audit entries) pass through; they aren't
    // note-scoped so there's nothing to gate.
    return rows.filter((r) => {
      if (r.noteId === null) return true;
      return canPerform('read', ctx, { kind: 'note', noteId: r.noteId });
    });
  },
});

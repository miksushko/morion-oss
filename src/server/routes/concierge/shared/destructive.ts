/**
 * Human-readable label resolution for destructive tool-call targets
 * (approval-card preface). Extracted from `../shared.ts` (2026-05-16,
 * ticket `01KRQYS1T925XEWBBJJYRJBGE2`).
 */

import type { ToolContext } from '../../../tools/types.js';

/**
 * Resolve a human-readable label for the target of a destructive
 * tool call so the approval card can say "Delete note 'Project spec'"
 * instead of dumping a raw ULID. Returns undefined when the target
 * can't be resolved (deleted between Mo emitting + persisting,
 * malformed args, unknown tool name) — UI falls back to args JSON.
 *
 * Lookup is best-effort. We keep this in the route module rather than
 * pushing into chat-approvals.ts because the resolution depends on
 * `ctx` (note + folder + tag + comment repos) which is server-only.
 */
export function resolveDestructiveTargetLabel(
  toolName: string,
  argumentsJson: string,
  ctx: ToolContext,
): string | undefined {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const id = (k: string): string | undefined =>
    typeof args[k] === 'string' ? (args[k] as string) : undefined;

  switch (toolName) {
    case 'notes_delete': {
      const noteId = id('id');
      if (!noteId) return undefined;
      const note = ctx.notes.getById(noteId, { includeTrashed: true });
      if (!note) return undefined;
      const title = note.title?.trim() || '(untitled)';
      return `note "${title}"`;
    }
    case 'folders_delete': {
      const folderId = id('id');
      if (!folderId) return undefined;
      const folder = ctx.folders.getById(folderId);
      if (!folder) return undefined;
      const count = folder.noteCount;
      const tail = count > 0 ? `, ${count} note${count === 1 ? '' : 's'}` : '';
      return `folder "${folder.name}"${tail}`;
    }
    case 'tags_delete': {
      const tagId = id('id');
      if (!tagId) return undefined;
      const tag = ctx.tags.getById(tagId);
      if (!tag) return undefined;
      return `tag "${tag.name}"`;
    }
    case 'notes_delete_comment': {
      const commentId = id('commentId');
      if (!commentId) return undefined;
      const comment = ctx.comments.getById(commentId);
      if (!comment) return undefined;
      const note = ctx.notes.getById(comment.noteId, { includeTrashed: true });
      const noteTitle = note?.title?.trim() || '(untitled)';
      return `comment on "${noteTitle}"`;
    }
    default:
      return undefined;
  }
}

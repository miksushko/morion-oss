import type { ToolContext } from '../tools/types.js';

/**
 * Delete a folder and, by DEFAULT, move its notes to Trash (soft-delete,
 * recoverable). Shared by the HTTP route (`DELETE /api/folders/:id`) and the
 * `folders_delete` MCP tool so both surfaces agree on the behavior.
 *
 * Rationale (ticket 01KVJ… folder-delete cascade): the old default left
 * regular notes behind as "unfiled" (folder_id → NULL via the FK), so
 * deleting a folder silently scattered its notes into All notes with no
 * cleanup. Deleting a folder now trashes its notes by default; pass
 * `keepNotes` to preserve the old "leave them unfiled" behavior explicitly.
 *
 * `mo:*` system notes (catalog / cluster / patrol-log / risks) are ALWAYS
 * hard-deleted regardless of `keepNotes` — they're machine-maintained
 * indices, not user content, and would just confuse Trash.
 *
 * Wrapped in a single transaction so a mid-delete failure can't leave the
 * folder gone but its notes half-processed.
 */
export function deleteFolderWithNotes(
  ctx: ToolContext,
  folderId: string,
  opts: { keepNotes?: boolean },
): { ok: boolean; trashedNoteCount: number } {
  const { actor } = ctx;
  return ctx.db.transaction(() => {
    const { regular, moSystem } = ctx.folders.noteIdsInside(folderId);
    for (const noteId of moSystem) {
      ctx.notes.hardDelete(noteId, actor);
    }
    let trashedNoteCount = 0;
    if (!opts.keepNotes) {
      for (const noteId of regular) {
        if (ctx.notes.delete(noteId, actor)) trashedNoteCount++;
      }
    }
    const ok = ctx.folders.delete(folderId);
    return { ok, trashedNoteCount };
  })();
}

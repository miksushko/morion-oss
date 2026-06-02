import { useCallback } from 'react';
import { api, type Tag } from '../lib/api';

/**
 * Tag catalogue CRUD. The note-level `tags: string[]` array stores
 * names, so renames + deletes need a notes refresh to re-resolve the
 * chips on existing notes.
 */
export function useTagOps(args: {
  setTags: React.Dispatch<React.SetStateAction<Tag[]>>;
  refreshNotes: () => Promise<void>;
}) {
  const { setTags, refreshNotes } = args;

  const createTag = useCallback(
    async (name: string, color: string | null): Promise<Tag> => {
      const created = await api.createTag(name, color);
      setTags((cur) => {
        // Server may have normalised the name; trust it.
        const without = cur.filter((t) => t.id !== created.id);
        return [...without, created].sort((a, b) => a.name.localeCompare(b.name));
      });
      return created;
    },
    [setTags],
  );

  const updateTagInCatalogue = useCallback(
    async (id: string, patch: { name?: string; color?: string | null }): Promise<Tag> => {
      const updated = await api.updateTag(id, patch);
      setTags((cur) =>
        cur
          .map((t) => (t.id === id ? updated : t))
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      // Renames change how chips on existing notes resolve.
      refreshNotes().catch(console.error);
      return updated;
    },
    [setTags, refreshNotes],
  );

  const deleteTagFromCatalogue = useCallback(
    async (id: string): Promise<void> => {
      await api.deleteTag(id);
      setTags((cur) => cur.filter((t) => t.id !== id));
      // CASCADE drops note_tags links — notes need to drop the name too.
      refreshNotes().catch(console.error);
    },
    [setTags, refreshNotes],
  );

  return { createTag, updateTagInCatalogue, deleteTagFromCatalogue };
}

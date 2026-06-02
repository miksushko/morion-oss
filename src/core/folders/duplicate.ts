import type { FoldersRepository } from './repository.js';
import type { NotesRepository } from '../notes/repository.js';
import type { Folder } from '../notes/types.js';

export interface DuplicateFolderResult {
  folder: Folder;
  newNoteIds: string[];
}

/**
 * Clone a folder with the "(Copy)" suffix and deep-copy every non-deleted
 * note inside it. Apple Notes parity: the duplicate is inserted right after
 * the source in the sidebar order, the source is left untouched, and each
 * copied note gets a fresh id + a fresh `created_at`/`updated_at` (so the
 * duplicates land at the top of the new folder's date-sorted list).
 *
 * The folder shell + position bump live in `FoldersRepository.duplicateShell`
 * — this function only orchestrates the note copying. We go through
 * `notes.create` (rather than raw SQL) so the audit log + FTS triggers fire
 * normally. Vector reindexing is the caller's responsibility (the HTTP
 * route loops `newNoteIds` and calls `indexer.reindex`).
 */
export function duplicateFolder(
  folders: FoldersRepository,
  notes: NotesRepository,
  sourceId: string,
  actor: string,
): DuplicateFolderResult | null {
  const source = folders.getById(sourceId);
  if (!source) return null;

  const shell = folders.duplicateShell(sourceId);
  if (!shell) return null;

  // Pull every non-deleted note from the source folder. The 500 cap matches
  // the schema-level limit on `noteListFiltersSchema`; folders larger than
  // that aren't an MVP concern.
  const sourceNotes = notes.list({ folderId: source.id, limit: 500, offset: 0 });

  const newNoteIds: string[] = [];
  for (const sn of sourceNotes) {
    const created = notes.create(
      {
        title: sn.title,
        body: sn.body,
        folderId: shell.id,
        tags: sn.tags,
        pinned: sn.pinned,
        source: 'user',
      },
      actor,
    );
    newNoteIds.push(created.id);
  }

  // Re-fetch so noteCount on the folder reflects the freshly-copied notes.
  const refreshed = folders.getById(shell.id);
  if (!refreshed) return null;

  return { folder: refreshed, newNoteIds };
}

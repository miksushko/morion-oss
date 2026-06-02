import { useEffect, useMemo, useState } from 'react';
import type { Note } from '../../lib/api';
import { useConfirm } from '../../components/ConfirmDialog';

export interface KanbanSelectionDeps {
  notes: Note[];
  folderId: string;
  onDeleteNote: (id: string) => Promise<void> | void;
  onMoveNoteToFolder: (id: string, folderId: string | null) => Promise<void> | void;
  onArchiveNote?: (id: string) => Promise<void> | void;
  onUnarchiveNote?: (id: string) => Promise<void> | void;
  onBulkDeleteNotes?: (ids: string[]) => Promise<void> | void;
  onBulkMoveNotesToFolder?: (ids: string[], folderId: string | null) => Promise<void> | void;
  onBulkArchiveNotes?: (ids: string[]) => Promise<void> | void;
  onBulkUnarchiveNotes?: (ids: string[]) => Promise<void> | void;
}

/**
 * Bulk-edit mode (ticket 01KPFPP356054AWVKCNAZSGYYR). Entering select
 * mode suppresses card-click-to-open and swaps the card body for a
 * checkbox toggle. Auto-exits when the user navigates to another folder
 * (keyed by folderId in the effect below) — matches the spec's "режим
 * выключается если пользователь выходит на другую страницу".
 *
 * Bulk handlers fall back to Promise.all over the single-note callbacks
 * when the parent doesn't supply a dedicated bulk variant, so existing
 * KanbanFolderView wiring keeps working with no extra props.
 */
export function useKanbanSelection(deps: KanbanSelectionDeps) {
  const {
    notes,
    folderId,
    onDeleteNote,
    onMoveNoteToFolder,
    onArchiveNote,
    onUnarchiveNote,
    onBulkDeleteNotes,
    onBulkMoveNotesToFolder,
    onBulkArchiveNotes,
    onBulkUnarchiveNotes,
  } = deps;

  const confirm = useConfirm();

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, [folderId]);

  // Drop selected ids that were soft-deleted (via live sync from MCP or
  // another tab) so the bar count matches reality.
  useEffect(() => {
    setSelectedIds((cur) => {
      if (cur.size === 0) return cur;
      const alive = new Set(notes.map((n) => n.id));
      let changed = false;
      const next = new Set<string>();
      cur.forEach((id) => {
        if (alive.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : cur;
    });
  }, [notes]);

  const toggleSelect = (id: string) => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  // Split the selection into archived vs. live ids so the bar can show
  // Archive, Unarchive, or both depending on what's actually selected.
  // Mixed selections (e.g. with "Show Archived" on) surface both buttons
  // and each acts only on the relevant subset.
  const selectionSplit = useMemo(() => {
    const toArchive: string[] = [];
    const toUnarchive: string[] = [];
    const idx = new Map(notes.map((n) => [n.id, n] as const));
    selectedIds.forEach((id) => {
      const n = idx.get(id);
      if (!n) return;
      if (n.archivedAt == null) toArchive.push(id);
      else toUnarchive.push(id);
    });
    return { toArchive, toUnarchive };
  }, [notes, selectedIds]);

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Delete ${ids.length} ${ids.length === 1 ? 'note' : 'notes'}?`,
      description:
        'They will be moved to Trash and purged after 7 days. You can restore them before then.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    if (onBulkDeleteNotes) {
      await onBulkDeleteNotes(ids);
    } else {
      await Promise.all(ids.map((id) => Promise.resolve(onDeleteNote(id))));
    }
    exitSelectMode();
  };

  const handleBulkMove = async (folderTo: string | null) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (onBulkMoveNotesToFolder) {
      await onBulkMoveNotesToFolder(ids, folderTo);
    } else {
      await Promise.all(
        ids.map((id) => Promise.resolve(onMoveNoteToFolder(id, folderTo))),
      );
    }
    exitSelectMode();
  };

  const handleBulkArchive = async () => {
    const ids = selectionSplit.toArchive;
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Archive ${ids.length} ${ids.length === 1 ? 'note' : 'notes'}?`,
      description:
        "They will be hidden from lists + search + MCP. You can restore them via 'Show Archived' in the gear menu.",
      confirmLabel: 'Archive',
    });
    if (!ok) return;
    if (onBulkArchiveNotes) {
      await onBulkArchiveNotes(ids);
    } else if (onArchiveNote) {
      await Promise.all(ids.map((id) => Promise.resolve(onArchiveNote(id))));
    }
    exitSelectMode();
  };

  const handleBulkUnarchive = async () => {
    const ids = selectionSplit.toUnarchive;
    if (ids.length === 0) return;
    if (onBulkUnarchiveNotes) {
      await onBulkUnarchiveNotes(ids);
    } else if (onUnarchiveNote) {
      await Promise.all(ids.map((id) => Promise.resolve(onUnarchiveNote(id))));
    }
    exitSelectMode();
  };

  return {
    selectMode,
    selectedIds,
    selectionSplit,
    setSelectMode,
    toggleSelect,
    exitSelectMode,
    handleBulkDelete,
    handleBulkMove,
    handleBulkArchive,
    handleBulkUnarchive,
  };
}

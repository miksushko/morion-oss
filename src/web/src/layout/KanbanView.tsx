import { useMemo, useState } from 'react';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { Bot } from 'lucide-react';
import type { NoteStatus } from '../lib/api';
import { deriveTitleFromBody } from '../lib/deriveTitle';
import { bucketKanbanCards } from '../lib/kanbanOrder';
import { AutoCodeDrawer } from '../components/AutoCodeDrawer';
import { ContextMenu, ContextMenuItem } from '../components/ContextMenu';
import { COLUMN_META, type KanbanViewProps } from './kanban/types';
import { CollapsedRail } from './kanban/CollapsedRail';
import { KanbanColumn } from './kanban/KanbanColumn';
import { KanbanCardPreview } from './kanban/KanbanCard';
import { BulkActionBar } from './kanban/BulkActionBar';
import { KanbanHeader } from './kanban/KanbanHeader';
import {
  CardContextMenu,
  type CardContextMenuState,
} from './kanban/CardContextMenu';
import { useKanbanSelection } from './kanban/useKanbanSelection';
import { useKanbanAutoCode } from './kanban/useKanbanAutoCode';
import { useKanbanDnd } from './kanban/useKanbanDnd';

export type { KanbanViewProps } from './kanban/types';

/**
 * Kanban view replaces NotesList + EditorPane when the active folder's
 * viewMode is 'kanban'. Full-width 6-column board:
 *   Note → Backlog → Todo → Doing → Review → Done
 *
 * Note column is a chronological reference pile (updated_at desc, no
 * manual ordering). The other five columns sort by `position` (ascending)
 * — the user drags to reorder, the repo computes midpoints.
 *
 * Composition shell only — leaf components, hooks, and helpers live under
 * `./kanban/`. When adding a feature, prefer a new module there over
 * inline state/effects/JSX here.
 */
export function KanbanView(props: KanbanViewProps) {
  const {
    folder,
    notes,
    folders,
    allTags,
    onMobileBack,
    onNewNote,
    onShareFolderWithLLM,
    onOpenConciergeSettings,
    conciergeEnabled,
    autoCodeEnabled,
    onOpenAutoCodeSettings,
    conciergeNeedsHuman,
    onChangeFolderViewMode,
    onOpenCard,
    onAddCardToColumn,
    onMoveTask,
    onShareNoteWithLLM,
    onCopyNoteBody,
    onDuplicateNote,
    onMoveNoteToFolder,
    onDeleteNote,
    onArchiveNote,
    onUnarchiveNote,
    onBulkMoveNotesToFolder,
    onBulkDeleteNotes,
    onBulkArchiveNotes,
    onBulkUnarchiveNotes,
    onOpenNoteAIAccess,
  } = props;

  const {
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
  } = useKanbanSelection({
    notes,
    folderId: folder.id,
    onDeleteNote,
    onMoveNoteToFolder,
    onArchiveNote,
    onUnarchiveNote,
    onBulkDeleteNotes,
    onBulkMoveNotesToFolder,
    onBulkArchiveNotes,
    onBulkUnarchiveNotes,
  });

  const [contextMenu, setContextMenu] = useState<CardContextMenuState | null>(null);
  // Board-level right-click — separate from per-card menu. Currently
  // exposes "Autocode settings". Per-card right-click stops propagation
  // so this only fires on the empty board background.
  const [boardContextMenu, setBoardContextMenu] = useState<
    { x: number; y: number } | null
  >(null);
  const contextNote = contextMenu
    ? notes.find((n) => n.id === contextMenu.noteId) ?? null
    : null;

  // Direction N — any column can be collapsed into a vertical rail. Only
  // the `note` column is collapsed by default (reference pile; users
  // rarely want it in their face). No auto-collapse on resize.
  const [collapsedCols, setCollapsedCols] = useState<Set<NoteStatus>>(
    () => new Set<NoteStatus>(['note']),
  );
  const toggleCollapsed = (key: NoteStatus) => {
    setCollapsedCols((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // bucketKanbanCards owns the sort — board + KanbanCardModal navigator
  // share one ordering source so arrow-keys stay consistent with the board.
  const columns = useMemo(() => bucketKanbanCards(notes), [notes]);

  const tagColorByName = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const t of allTags ?? []) m.set(t.name, t.color ?? null);
    return m;
  }, [allTags]);

  const {
    autoCodeRows,
    autoCodeDrawerTaskId,
    autoCodeDrawerNote,
    handleOpenAutoCode,
    closeAutoCodeDrawer,
  } = useKanbanAutoCode(notes);

  const {
    activeDragId,
    sensors,
    collisionDetection,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  } = useKanbanDnd(columns, onMoveTask);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-background">
      <KanbanHeader
        folder={folder}
        notesCount={notes.length}
        autoCodeEnabled={autoCodeEnabled}
        onOpenAutoCodeSettings={onOpenAutoCodeSettings}
        selectMode={selectMode}
        onToggleSelectMode={() => {
          if (selectMode) exitSelectMode();
          else setSelectMode(true);
        }}
        onOpenConciergeSettings={onOpenConciergeSettings}
        conciergeEnabled={conciergeEnabled}
        conciergeNeedsHuman={conciergeNeedsHuman}
        onChangeFolderViewMode={onChangeFolderViewMode}
        onShareFolderWithLLM={onShareFolderWithLLM}
        onNewNote={onNewNote}
        onMobileBack={onMobileBack}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div
          className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3"
          onContextMenu={(e) => {
            if (!onOpenAutoCodeSettings) return;
            e.preventDefault();
            setBoardContextMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          {COLUMN_META.map((meta) => {
            const cards = columns[meta.key];
            return collapsedCols.has(meta.key) ? (
              <CollapsedRail
                key={meta.key}
                label={meta.label}
                count={cards.length}
                accent={meta.accent}
                onExpand={() => toggleCollapsed(meta.key)}
              />
            ) : (
              <KanbanColumn
                key={meta.key}
                status={meta.key}
                label={meta.label}
                description={meta.description}
                accent={meta.accent}
                cards={cards}
                onOpenCard={onOpenCard}
                onAddCard={() => onAddCardToColumn(meta.key)}
                onCollapseColumn={() => toggleCollapsed(meta.key)}
                onCardContextMenu={(noteId, x, y) =>
                  setContextMenu({ noteId, x, y, view: 'main' })
                }
                selectMode={selectMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                tagColorByName={tagColorByName}
                autoCodeRows={autoCodeRows}
                folderAutoCodeEnabled={autoCodeEnabled ?? false}
                onOpenAutoCode={handleOpenAutoCode}
              />
            );
          })}
        </div>

        <DragOverlay>
          {activeDragId
            ? (() => {
                const card = notes.find((n) => n.id === activeDragId);
                return card ? (
                  <KanbanCardPreview
                    note={card}
                    tagColorByName={tagColorByName}
                    autoCodeRow={autoCodeRows.get(card.id) ?? null}
                  />
                ) : null;
              })()
            : null}
        </DragOverlay>
      </DndContext>

      {autoCodeDrawerTaskId && (
        <AutoCodeDrawer
          taskId={autoCodeDrawerTaskId}
          taskTitle={
            autoCodeDrawerNote?.title ||
            deriveTitleFromBody(autoCodeDrawerNote?.body ?? '') ||
            'Untitled'
          }
          onClose={closeAutoCodeDrawer}
        />
      )}

      {contextMenu && contextNote && (
        <CardContextMenu
          state={contextMenu}
          contextNote={contextNote}
          notes={notes}
          folders={folders}
          onClose={() => setContextMenu(null)}
          onSetView={(view) => setContextMenu({ ...contextMenu, view })}
          onShareNoteWithLLM={onShareNoteWithLLM}
          onCopyNoteBody={onCopyNoteBody}
          onDuplicateNote={onDuplicateNote}
          onMoveNoteToFolder={onMoveNoteToFolder}
          onDeleteNote={onDeleteNote}
          onArchiveNote={onArchiveNote}
          onUnarchiveNote={onUnarchiveNote}
          onOpenNoteAIAccess={onOpenNoteAIAccess}
        />
      )}

      {boardContextMenu && onOpenAutoCodeSettings && (
        <ContextMenu
          x={boardContextMenu.x}
          y={boardContextMenu.y}
          onClose={() => setBoardContextMenu(null)}
          ariaLabel="Board actions"
        >
          <ContextMenuItem
            icon={<Bot className="h-3.5 w-3.5" />}
            label="Autocode settings"
            onClick={() => {
              setBoardContextMenu(null);
              onOpenAutoCodeSettings();
            }}
          />
        </ContextMenu>
      )}

      {selectMode && selectedIds.size > 0 && (
        <BulkActionBar
          count={selectedIds.size}
          folders={folders}
          currentFolderId={folder.id}
          onMoveTo={handleBulkMove}
          onDelete={() => void handleBulkDelete()}
          onArchive={
            selectionSplit.toArchive.length > 0
              ? () => void handleBulkArchive()
              : undefined
          }
          onUnarchive={
            selectionSplit.toUnarchive.length > 0
              ? () => void handleBulkUnarchive()
              : undefined
          }
          archiveCount={selectionSplit.toArchive.length}
          unarchiveCount={selectionSplit.toUnarchive.length}
          onClear={exitSelectMode}
        />
      )}
    </div>
  );
}

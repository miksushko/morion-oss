import { useCallback, useState } from 'react';
import { Sidebar } from './layout/Sidebar';
import { AppDialogsLayer } from './components/AppDialogsLayer';
import { NotesEditorView } from './components/NotesEditorView';
import { KanbanFolderView } from './components/KanbanFolderView';
import { TrashView } from './components/TrashView';
import { TagsView } from './components/TagsView';
import { ConciergeView } from './components/ConciergeView';
import { ToastBanner } from './components/ToastBanner';
import { WelcomeView } from './components/WelcomeView';
import { FirstRunConsent } from './layout/FirstRunConsent';
import { CommandPalette } from './search/CommandPalette';
import { useConfirm } from './components/ConfirmDialog';
import { usePrompt } from './components/PromptDialog';
import { UpdateBanner } from './components/UpdateBanner';
import { useEnvReady } from './hooks/useEnvReady';
import { useLiveSync } from './hooks/useLiveSync';
import { useToast } from './hooks/useToast';
import { useShowArchived } from './hooks/useShowArchived';
import { useTermsGate } from './hooks/useTermsGate';
import { useUpdateCheck } from './hooks/useUpdateCheck';
import { useGlobalKeyboardShortcuts } from './hooks/useGlobalKeyboardShortcuts';
import { useConciergeChat } from './hooks/useConciergeChat';
import { useConciergeHashRoute } from './hooks/useConciergeHashRoute';
import { useAutosave } from './hooks/useAutosave';
import { useTagOps } from './hooks/useTagOps';
import { useTrashOps } from './hooks/useTrashOps';
import { useRevisionOps } from './hooks/useRevisionOps';
import { useFolderOps } from './hooks/useFolderOps';
import { useKanbanOps } from './hooks/useKanbanOps';
import { useNoteOps } from './hooks/useNoteOps';
import { useAppDialogs } from './hooks/useAppDialogs';
import { useNotesData } from './hooks/useNotesData';
import { useMobilePane } from './hooks/useMobilePane';
import { useActivityPanels } from './hooks/useActivityPanels';
import { useMcpSettings } from './hooks/useMcpSettings';
import { useSelectionState } from './hooks/useSelectionState';
import { useSelectionEffects } from './hooks/useSelectionEffects';
import { needsTermsConsent } from './lib/termsGate';

import type { AppView, MobilePane } from './appShellTypes';

/**
 * Root app component. No router — single screen, selection lives in local
 * state. When we need modals (command palette, settings) they overlay the
 * layout, they're not separate routes.
 *
 * Notes are loaded once and filtered client-side by `selectedFolderId`. This
 * keeps move-between-folders logic dead simple (mutate folderId in place,
 * client filter handles the rest) and makes the "All notes" total count
 * trivial. Server-side filtering would be a premature optimisation given
 * MVP-scale notebooks.
 */
/**
 * First-page cap for the initial notes load. A thousand notes comfortably
 * covers the Apple Notes-style "open app, see everything" UX for every real
 * notebook I have measured; anything beyond that is paged in via
 * `loadMoreNotes` triggered from NotesList's infinite scroll. The server
 * still caps at 5000 per request regardless of what we ask for.
 */
export function App() {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const {
    selectedFolderId,
    setSelectedFolderId,
    selectedId,
    setSelectedId,
    selectedTrashId,
    setSelectedTrashId,
    pendingSearchSelectionRef,
  } = useSelectionState();
  const [view, setView] = useState<AppView>('notes');
  const { mobilePane, setMobilePane, editorFullscreen, setEditorFullscreen, paneClass } = useMobilePane();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { mcpEnabled, reviewMcp, setReviewMcp, handleMcpStateChange } = useMcpSettings();
  const [showArchived, setShowArchived] = useShowArchived();
  const {
    liveRev,
    kanbanActivityCollapsed,
    setKanbanActivityCollapsed,
    editorActivityCollapsed,
    setEditorActivityCollapsed,
    onLiveSyncTick,
  } = useActivityPanels();
  const { toast, showToast } = useToast();

  // Resolve Tauri IPC before any API call fires. In browser this is
  // an immediate `true`. R2 2026-04-17 — extracted to a hook.
  const envReady = useEnvReady();

  const {
    allNotes,
    setAllNotes,
    totalNotes,
    globalNoteCount,
    folders,
    setFolders,
    tags,
    setTags,
    trashedNotes,
    setTrashedNotes,
    visibleNotes,
    activeFolder,
    refreshNotes,
    loadMoreNotes,
    refreshFolders,
    refreshTags,
    refreshTrash,
  } = useNotesData({ envReady, view, selectedFolderId, showArchived });
  const dialogs = useAppDialogs({ refreshNotes });
  const {
    setFolderSettingsDialog,
    setSettingsDialog,
    setImportTriggerOpen,
    requestAIAccess,
  } = dialogs;
  const { termsInfo, acceptTerms: handleAcceptTerms } = useTermsGate(envReady);
  const {
    inflightSessionIds: conciergeInflightSessionIds,
    needsHumanCount: conciergeNeedsHumanCount,
    refreshNeedsHumanCount: refreshConciergeNeedsHumanCount,
    send: handleConciergeSend,
    stop: handleConciergeStop,
    preselectSessionId: conciergePreselectSessionId,
    setPreselectSessionId: setConciergePreselectSessionId,
    autoOpenSettings: conciergeAutoOpenSettings,
    setAutoOpenSettings: setConciergeAutoOpenSettings,
  } = useConciergeChat(envReady, view);

  // Live sync: WebSocket connection to /api/events so UI picks up
  // cross-process writes (MCP) immediately. R2 2026-04-17 — extracted.
  // Direction Q: bump `liveRev` on every db.changed so the
  // ActivityPanel (which doesn't have a "refresh collection" entry
  // point — its data is per-note) knows to refetch.
  //
  // `onTick` is the ref-stable callback from useActivityPanels.
  useLiveSync(envReady, {
    refreshNotes,
    refreshFolders,
    refreshTags,
    refreshTrash,
    onTick: onLiveSyncTick,
  });

  const {
    selectedNote,
    selectFolder: handleSelectFolder,
    selectView: handleSelectView,
    selectFromSearch: handleSelectFromSearch,
  } = useSelectionEffects({
    selectedFolderId,
    setSelectedFolderId,
    selectedId,
    setSelectedId,
    selectedTrashId,
    setSelectedTrashId,
    pendingSearchSelectionRef,
    view,
    setView,
    setMobilePane,
    visibleNotes,
    trashedNotes,
    allNotes,
    activeFolder,
    refreshTrash,
  });

  useConciergeHashRoute({
    selectView: handleSelectView,
    setPreselectSessionId: setConciergePreselectSessionId,
  });

  const {
    saveStates,
    handleEdit,
    flushAndSnapshotForRevision,
    markFresh,
    forgetNote,
    cancelPendingSave,
  } = useAutosave({
    selectedId,
    view,
    allNotes,
    setAllNotes,
    refreshNotes,
    showToast,
  });


  /**
   * Restore a soft-deleted note from the trash. Optimistic — drops it from
   * the local trash list and re-fetches the live list / folder counts so the
   * note re-materializes wherever it used to live. The note keeps its
   * original `updatedAt` (server-side, restore is metadata) so it lands at
   * its original position in the date-sorted view.
   */
  const {
    restoreSelectedTrashNote: handleRestoreSelectedTrashNote,
    deleteForeverSelectedTrashNote: handleDeleteForeverSelectedTrashNote,
    emptyTrash: handleEmptyTrash,
  } = useTrashOps({
    selectedTrashId,
    trashedNotes,
    setTrashedNotes,
    refreshNotes,
    refreshFolders,
    refreshTags,
    refreshTrash,
    showToast,
    confirm,
  });


  const {
    createTag: handleCreateTag,
    updateTagInCatalogue: handleUpdateTagInCatalogue,
    deleteTagFromCatalogue: handleDeleteTagFromCatalogue,
  } = useTagOps({ setTags, refreshNotes });

  const {
    createFolder: handleCreateFolder,
    createKanbanFolder: handleCreateKanbanFolder,
    renameFolder: handleRenameFolder,
    deleteFolder: handleDeleteFolder,
    archiveFolder: handleArchiveFolder,
    unarchiveFolder: handleUnarchiveFolder,
    duplicateFolder: handleDuplicateFolder,
    moveFolder: handleMoveFolder,
    reorderFolders: handleReorderFolders,
    shareFolderWithLLM: handleShareFolderWithLLM,
    openFolderSettings: handleOpenFolderSettings,
  } = useFolderOps({
    folders,
    setFolders,
    selectedFolderId,
    setSelectedFolderId,
    setView,
    setMobilePane,
    refreshNotes,
    refreshTags,
    showToast,
    setFolderSettingsDialog,
  });

  const {
    newNote: handleNewNote,
    selectNote: handleSelectNote,
    deleteNote: handleDeleteNote,
    deleteSelected: handleDelete,
    updateNoteTags: handleUpdateNoteTags,
    moveNote: handleMoveNote,
    archiveNote: handleArchiveNote,
    unarchiveNote: handleUnarchiveNote,
    duplicateNote: handleDuplicateNote,
    bulkDeleteNotes: handleBulkDeleteNotes,
    bulkArchiveNotes: handleBulkArchiveNotes,
    bulkUnarchiveNotes: handleBulkUnarchiveNotes,
    bulkMoveNotes: handleBulkMoveNotes,
    shareNoteWithLLM: handleShareNoteWithLLM,
    copyNoteBody: handleCopyNoteBody,
    shareSelectedWithLLM: handleShareSelectedWithLLM,
    copySelectedBody: handleCopySelectedBody,
    duplicateSelectedNote: handleDuplicateSelectedNote,
    moveSelectedNoteToFolder: handleMoveSelectedNoteToFolder,
  } = useNoteOps({
    allNotes,
    setAllNotes,
    selectedId,
    setSelectedId,
    setSelectedTrashId,
    selectedNote,
    selectedFolderId,
    setSelectedFolderId,
    view,
    setView,
    setMobilePane,
    folders,
    showArchived,
    refreshNotes,
    refreshFolders,
    refreshTags,
    refreshTrash,
    showToast,
    markFresh,
    forgetNote,
  });


  /**
   * Bumped after a successful revision restore. EditorPane watches this and
   * force-resyncs its local title/body from the (now-updated) note prop —
   * normally a same-id prop change is treated as a typing round-trip and the
   * local state stays put.
   */
  const {
    editorSyncToken,
    restoreRevision: handleRestoreRevision,
    copyRevisionBody: handleCopyRevisionBody,
  } = useRevisionOps({
    selectedId,
    setAllNotes,
    cancelPendingSave,
    refreshTags,
    refreshFolders,
    showToast,
  });


  const {
    conciergeFolderEnabled,
    setConciergeFolderEnabled,
    autoCodeFolderEnabled,
    setAutoCodeFolderEnabled,
    changeFolderViewMode: handleChangeFolderViewMode,
    moveTaskInKanban: handleKanbanMove,
    openCard: handleOpenKanbanCard,
    addCard: handleAddKanbanCard,
    closeDrawer: handleCloseKanbanDrawer,
  } = useKanbanOps({
    activeFolder,
    folders,
    selectedId,
    setSelectedId,
    selectedFolderId,
    setAllNotes,
    setMobilePane,
    refreshNotes,
    refreshFolders,
    showToast,
    markFresh,
    flushAndSnapshotForRevision,
    confirm,
  });

  const togglePalette = useCallback(() => setPaletteOpen((cur) => !cur), []);
  useGlobalKeyboardShortcuts({
    newNote: handleNewNote,
    deleteSelected: handleDelete,
    togglePalette,
    setMobilePane,
    setEditorFullscreen,
  });

  const totalNoteCount = globalNoteCount;

  const { registerCheck: registerUpdateCheck, triggerManualCheck: handleManualUpdateCheck } =
    useUpdateCheck(envReady, showToast);


  // First-run / re-consent gate. Render INSTEAD of the main shell when
  // the stored ToS version is missing or older than the build's
  // `CURRENT_TERMS_VERSION`. `termsInfo === null` means the fetch is
  // still in flight — render nothing (not even the main shell) to
  // avoid a flash of authenticated UI before the user has accepted.
  if (termsInfo === null) {
    return <div className="flex h-full w-full bg-background" />;
  }
  if (needsTermsConsent(termsInfo)) {
    return (
      <FirstRunConsent
        variant={termsInfo.acceptedVersion ? 're-consent' : 'first-run'}
        currentVersion={termsInfo.current}
        onAccept={handleAcceptTerms}
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <UpdateBanner ready={envReady} onRegisterCheck={registerUpdateCheck} />
      <div className="flex min-h-0 flex-1">
      <div className={paneClass('folders')}>
        <Sidebar
          folders={folders}
          view={view}
          selectedFolderId={selectedFolderId}
          totalNoteCount={totalNoteCount}
          tagCount={tags.length}
          trashCount={trashedNotes.length}
          conciergeNeedsHumanCount={conciergeNeedsHumanCount}
          conciergeThinking={conciergeInflightSessionIds.size > 0}
          mcpEnabled={mcpEnabled}
          onSelectFolder={handleSelectFolder}
          onSelectView={handleSelectView}
          onCreateFolder={handleCreateFolder}
          onCreateKanbanFolder={handleCreateKanbanFolder}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
          onArchiveFolder={handleArchiveFolder}
          onUnarchiveFolder={handleUnarchiveFolder}
          onDuplicateFolder={handleDuplicateFolder}
          onMoveFolder={handleMoveFolder}
          onReorderFolders={handleReorderFolders}
          onMoveNoteToFolder={handleMoveNote}
          onShareFolderWithLLM={handleShareFolderWithLLM}
          onOpenFolderSettings={handleOpenFolderSettings}
          onChangeFolderViewMode={handleChangeFolderViewMode}
          onOpenSearch={() => setPaletteOpen(true)}
          onOpenImport={() => setImportTriggerOpen(true)}
          reviewMcp={reviewMcp}
          onToggleReviewMcp={() => setReviewMcp((v) => !v)}
          showArchived={showArchived}
          onToggleShowArchived={() => setShowArchived(!showArchived)}
          onOpenUnifiedSettings={() => setSettingsDialog({ tab: 'general' })}
          onOpenMcpSettings={() => setSettingsDialog({ tab: 'mcp-server' })}
        />
      </div>
      {view === 'tags' ? (
        <TagsView
          tags={tags}
          paneClass={paneClass}
          setMobilePane={setMobilePane}
          onCreate={handleCreateTag}
          onUpdate={handleUpdateTagInCatalogue}
          onDelete={handleDeleteTagFromCatalogue}
        />
      ) : view === 'concierge' ? (
        <ConciergeView
          paneClass={paneClass}
          setMobilePane={setMobilePane}
          preselectSessionId={conciergePreselectSessionId}
          setPreselectSessionId={setConciergePreselectSessionId}
          autoOpenSettings={conciergeAutoOpenSettings}
          setAutoOpenSettings={setConciergeAutoOpenSettings}
          inflightSessionIds={conciergeInflightSessionIds}
          onSendMessage={handleConciergeSend}
          onStopSending={handleConciergeStop}
          refreshNeedsHumanCount={refreshConciergeNeedsHumanCount}
          onOpenMoAgentSettings={() => setSettingsDialog({ tab: 'mo-agent' })}
        />
      ) : view === 'trash' ? (
        <TrashView
          trashedNotes={trashedNotes}
          folders={folders}
          tags={tags}
          selectedTrashId={selectedTrashId}
          selectedNote={selectedNote}
          reviewMcp={reviewMcp}
          paneClass={paneClass}
          setMobilePane={setMobilePane}
          onSelectNote={handleSelectNote}
          onNewNote={handleNewNote}
          onShareNoteWithLLM={handleShareNoteWithLLM}
          onCopyNoteBody={handleCopyNoteBody}
          onDuplicateNote={handleDuplicateNote}
          onMoveNote={handleMoveNote}
          onDeleteNote={handleDeleteNote}
          onEmptyTrash={handleEmptyTrash}
          onEditNote={handleEdit}
          onDeleteSelected={handleDelete}
          onCreateTag={handleCreateTag}
          onShareSelectedWithLLM={handleShareSelectedWithLLM}
          onCopySelectedBody={handleCopySelectedBody}
          onDuplicateSelectedNote={handleDuplicateSelectedNote}
          onMoveSelectedNoteToFolder={handleMoveSelectedNoteToFolder}
          onRestoreSelected={handleRestoreSelectedTrashNote}
          onDeleteForeverSelected={handleDeleteForeverSelectedTrashNote}
        />
      ) : activeFolder && activeFolder.viewMode === 'kanban' ? (
        <KanbanFolderView
          activeFolder={activeFolder}
          folders={folders}
          visibleNotes={visibleNotes}
          tags={tags}
          selectedNote={selectedNote}
          saveStates={saveStates}
          editorSyncToken={editorSyncToken}
          liveRev={liveRev}
          conciergeFolderEnabled={conciergeFolderEnabled}
          autoCodeFolderEnabled={autoCodeFolderEnabled}
          setAutoCodeFolderEnabled={setAutoCodeFolderEnabled}
          kanbanActivityCollapsed={kanbanActivityCollapsed}
          setKanbanActivityCollapsed={setKanbanActivityCollapsed}
          paneClass={paneClass}
          setMobilePane={setMobilePane}
          onNewNote={handleNewNote}
          onShareNoteWithLLM={handleShareNoteWithLLM}
          onCopyNoteBody={handleCopyNoteBody}
          onDuplicateNote={handleDuplicateNote}
          onMoveNote={handleMoveNote}
          onDeleteNote={handleDeleteNote}
          onArchiveNote={handleArchiveNote}
          onUnarchiveNote={handleUnarchiveNote}
          onBulkDeleteNotes={handleBulkDeleteNotes}
          onBulkArchiveNotes={handleBulkArchiveNotes}
          onBulkUnarchiveNotes={handleBulkUnarchiveNotes}
          onBulkMoveNotes={handleBulkMoveNotes}
          onEditNote={handleEdit}
          onUpdateNoteTags={handleUpdateNoteTags}
          onDeleteSelected={handleDelete}
          onShareSelectedWithLLM={handleShareSelectedWithLLM}
          onCopySelectedBody={handleCopySelectedBody}
          onDuplicateSelectedNote={handleDuplicateSelectedNote}
          onMoveSelectedNoteToFolder={handleMoveSelectedNoteToFolder}
          onCreateTag={handleCreateTag}
          onRestoreRevision={handleRestoreRevision}
          onCopyRevisionBody={handleCopyRevisionBody}
          onShareFolderWithLLM={handleShareFolderWithLLM}
          onChangeFolderViewMode={handleChangeFolderViewMode}
          onOpenFolderSettings={handleOpenFolderSettings}
          onOpenCard={handleOpenKanbanCard}
          onAddCard={handleAddKanbanCard}
          onMoveTask={handleKanbanMove}
          onCloseDrawer={handleCloseKanbanDrawer}
          onRequestAIAccess={requestAIAccess}
          showToast={showToast}
        />
      ) : allNotes.length === 0 &&
        !selectedId &&
        selectedFolderId === undefined &&
        view === 'notes' ? (
        <WelcomeView
          paneClass={paneClass}
          onNewNote={handleNewNote}
          onOpenSearch={() => setPaletteOpen(true)}
          onOpenMcpSettings={() => setSettingsDialog({ tab: 'mcp-server' })}
        />
      ) : (
        <NotesEditorView
          visibleNotes={visibleNotes}
          allNotes={allNotes}
          totalNotes={totalNotes}
          folders={folders}
          tags={tags}
          activeFolder={activeFolder}
          selectedFolderId={selectedFolderId}
          selectedId={selectedId}
          selectedNote={selectedNote}
          saveStates={saveStates}
          editorSyncToken={editorSyncToken}
          liveRev={liveRev}
          reviewMcp={reviewMcp}
          editorActivityCollapsed={editorActivityCollapsed}
          setEditorActivityCollapsed={setEditorActivityCollapsed}
          paneClass={paneClass}
          setMobilePane={setMobilePane}
          onSelectNote={handleSelectNote}
          onNewNote={handleNewNote}
          onDeleteNote={handleDeleteNote}
          onArchiveNote={handleArchiveNote}
          onUnarchiveNote={handleUnarchiveNote}
          onDuplicateNote={handleDuplicateNote}
          onMoveNote={handleMoveNote}
          onShareNoteWithLLM={handleShareNoteWithLLM}
          onCopyNoteBody={handleCopyNoteBody}
          onLoadMore={loadMoreNotes}
          onEditNote={handleEdit}
          onUpdateNoteTags={handleUpdateNoteTags}
          onDeleteSelected={handleDelete}
          onShareSelectedWithLLM={handleShareSelectedWithLLM}
          onCopySelectedBody={handleCopySelectedBody}
          onDuplicateSelectedNote={handleDuplicateSelectedNote}
          onMoveSelectedNoteToFolder={handleMoveSelectedNoteToFolder}
          onCreateTag={handleCreateTag}
          onRenameFolder={handleRenameFolder}
          onDeleteFolder={handleDeleteFolder}
          onArchiveFolder={handleArchiveFolder}
          onUnarchiveFolder={handleUnarchiveFolder}
          onDuplicateFolder={handleDuplicateFolder}
          onMoveFolder={handleMoveFolder}
          onShareFolderWithLLM={handleShareFolderWithLLM}
          onChangeFolderViewMode={handleChangeFolderViewMode}
          onRestoreRevision={handleRestoreRevision}
          onCopyRevisionBody={handleCopyRevisionBody}
          onOpenFolderAccess={(f) => setFolderSettingsDialog({ folder: f, tab: 'access' })}
          onRequestAIAccess={requestAIAccess}
          showToast={showToast}
          confirm={confirm}
          prompt={prompt}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        folders={folders}
        onClose={() => setPaletteOpen(false)}
        onSelect={handleSelectFromSearch}
      />
      <ToastBanner message={toast} />
      <AppDialogsLayer
        dialogs={dialogs}
        setAutoCodeFolderEnabled={setAutoCodeFolderEnabled}
        setConciergeFolderEnabled={setConciergeFolderEnabled}
        setView={setView}
        setConciergeAutoOpenSettings={setConciergeAutoOpenSettings}
        refreshNotes={refreshNotes}
        refreshFolders={refreshFolders}
        refreshTags={refreshTags}
        refreshTrash={refreshTrash}
        showToast={showToast}
        handleManualUpdateCheck={handleManualUpdateCheck}
        handleMcpStateChange={handleMcpStateChange}
        handleSelectFolder={handleSelectFolder}
      />
      </div>
    </div>
  );
}

import { FolderSettingsDialog } from './FolderSettingsDialog';
import { AutoCodePopup } from './AutoCodePopup';
import { SettingsDialog } from './SettingsDialog';
import { MCPPermissionsDialog } from './MCPPermissionsDialog';
import { ImportTriggerDialog } from './ImportTriggerDialog';
import { ImportProgressModal } from './ImportProgressModal';
import { AppleNotesImportDialog } from './AppleNotesImportDialog';
import type { McpSettings } from '../lib/api';
import type { useAppDialogs } from '../hooks/useAppDialogs';

type AppDialogsBag = ReturnType<typeof useAppDialogs>;
import type { UpdateCheckResult } from './UpdateBanner';

/**
 * Overlay layer at the bottom of `<App />`. Renders every modal /
 * popup the app shell owns. Each one is independently conditioned on
 * its own state slot; only one is normally interactive at a time, but
 * a few can coexist (e.g. AutoCode Workflows popup sits on top of
 * FolderSettingsDialog by design — see `onOpenWorkflowsPopup`).
 *
 * The component is intentionally prop-heavy: every callback the
 * dialogs need is threaded through. App.tsx already owns these (via
 * `useAppDialogs` + the various ops hooks); the alternative — context
 * or a global store — would obscure the data flow without removing
 * the dependency. Treat this as the "JSX seam" of the dialog cluster.
 */
export interface AppDialogsLayerProps {
  /** Whole useAppDialogs() return bundle. State slots + setters +
   *  requestAIAccess / onAIAccessSaved. */
  dialogs: AppDialogsBag;

  // Cross-cutting callbacks owned by other hooks / App.
  setAutoCodeFolderEnabled: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setConciergeFolderEnabled: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setView: (view: 'notes' | 'tags' | 'trash' | 'concierge') => void;
  setConciergeAutoOpenSettings: (next: boolean) => void;
  refreshNotes: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  refreshTags: () => Promise<void>;
  refreshTrash: () => Promise<void>;
  showToast: (message: string) => void;
  handleManualUpdateCheck: () => Promise<UpdateCheckResult | null>;
  handleMcpStateChange: (mcp: McpSettings) => void;
  handleSelectFolder: (folderId: string | undefined) => void;
}

export function AppDialogsLayer(props: AppDialogsLayerProps) {
  const {
    dialogs: {
      aiAccessTarget,
      setAiAccessTarget,
      autoCodePopupFolder,
      setAutoCodePopupFolder,
      settingsDialog,
      setSettingsDialog,
      folderSettingsDialog,
      setFolderSettingsDialog,
      importTriggerOpen,
      setImportTriggerOpen,
      appleNotesOpen,
      setAppleNotesOpen,
      importBatchId,
      setImportBatchId,
      onAIAccessSaved,
    },
    setAutoCodeFolderEnabled,
    setConciergeFolderEnabled,
    setView,
    setConciergeAutoOpenSettings,
    refreshNotes,
    refreshFolders,
    refreshTags,
    refreshTrash,
    showToast,
    handleManualUpdateCheck,
    handleMcpStateChange,
    handleSelectFolder,
  } = props;

  return (
    <>
      {aiAccessTarget && (
        <MCPPermissionsDialog
          target={aiAccessTarget}
          onSaved={onAIAccessSaved}
          onClose={() => setAiAccessTarget(null)}
        />
      )}
      {autoCodePopupFolder && (
        <AutoCodePopup
          folderId={autoCodePopupFolder.folder.id}
          folderName={autoCodePopupFolder.folder.name}
          initialWorkflowId={autoCodePopupFolder.initialWorkflowId}
          onClose={() => setAutoCodePopupFolder(null)}
          onSettingsUpdated={(next) => {
            const fid = autoCodePopupFolder.folder.id;
            setAutoCodeFolderEnabled((prev) => ({ ...prev, [fid]: next.autoCodeEnabled }));
            setConciergeFolderEnabled((prev) => ({ ...prev, [fid]: next.enabled }));
          }}
        />
      )}
      {settingsDialog && (
        <SettingsDialog
          initialTab={settingsDialog.tab}
          onClose={() => setSettingsDialog(null)}
          onCheckForUpdates={handleManualUpdateCheck}
          onRefreshData={async () => {
            await Promise.all([refreshNotes(), refreshFolders(), refreshTags(), refreshTrash()]);
            showToast('Refreshed');
          }}
          onMcpStateChange={handleMcpStateChange}
        />
      )}
      {folderSettingsDialog && (
        <FolderSettingsDialog
          folder={folderSettingsDialog.folder}
          initialTab={folderSettingsDialog.tab}
          onClose={() => setFolderSettingsDialog(null)}
          onFolderUpdated={(updated) => {
            // Optimistic refresh so the sidebar reflects new perms
            // (e.g. lock icon visibility) immediately.
            refreshFolders().catch(console.error);
            setFolderSettingsDialog((prev) =>
              prev && prev.folder.id === updated.id ? { ...prev, folder: updated } : prev,
            );
          }}
          onOpenWorkspaceMoSettings={() => {
            // Route user to Ask Mo panel AND flip the gear popover open.
            setFolderSettingsDialog(null);
            setView('concierge');
            setConciergeAutoOpenSettings(true);
          }}
          onOpenWorkflowsPopup={(workflowId) => {
            setAutoCodePopupFolder({
              folder: folderSettingsDialog.folder,
              initialWorkflowId: workflowId,
            });
          }}
        />
      )}
      <ImportTriggerDialog
        open={importTriggerOpen}
        onClose={() => setImportTriggerOpen(false)}
        onStarted={(batchId) => {
          setImportTriggerOpen(false);
          setImportBatchId(batchId);
        }}
        onOpenAppleNotes={() => setAppleNotesOpen(true)}
      />
      <AppleNotesImportDialog
        open={appleNotesOpen}
        onClose={() => setAppleNotesOpen(false)}
        onStarted={(batchId) => {
          setAppleNotesOpen(false);
          setImportBatchId(batchId);
        }}
      />
      <ImportProgressModal
        batchId={importBatchId}
        onClose={() => {
          setImportBatchId(null);
          void Promise.all([refreshNotes(), refreshFolders()]);
        }}
        onOpenFolder={(folderId) => {
          // Use the canonical sidebar-click handler — sets view='notes' +
          // mobilePane='notes' the same way clicking the sidebar does.
          handleSelectFolder(folderId);
        }}
      />
    </>
  );
}

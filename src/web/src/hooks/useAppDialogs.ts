import { useCallback, useState } from 'react';
import type { Folder, Note } from '../lib/api';
import type { FolderSettingsTab } from '../components/FolderSettingsDialog';
import type { SettingsTab } from '../components/SettingsDialog';

export type FolderSettingsState = { folder: Folder; tab: FolderSettingsTab } | null;
export type SettingsState = { tab: SettingsTab } | null;
export type AutoCodePopupState = { folder: Folder; initialWorkflowId: string | null } | null;
export type AiAccessState = { kind: 'note'; note: Note; folder: Folder | null } | null;

/**
 * Single-state-of-truth bucket for every overlay App renders below the
 * main layout. Each one is independent (only one shows at a time
 * because the user can only interact with one at a time), but they
 * cluster together because:
 *
 *   - One dialog often opens another (Folder Settings → Workflows
 *     popup).
 *   - The "cancel" path of every dialog is the same — clear its slot.
 *   - The bottom of App.tsx renders them all conditionally; grouping
 *     the state makes the render block trivially refactorable into an
 *     <AppDialogsLayer /> component.
 *
 * Returns raw setters rather than a verb-based API because callers
 * frequently chain (`setSettingsDialog({tab: 'general'}); setMobilePane('editor')`).
 */
export function useAppDialogs(args: {
  refreshNotes: () => Promise<void>;
}) {
  const { refreshNotes } = args;

  /** Single per-folder settings popup. Replaces the previous three
   * separate dialogs (MCPPermissionsDialog folder-mode +
   * ConciergeSettingsDialog + ProjectBriefDialog). The note-level
   * AI access dialog still lives in `aiAccessTarget` below. */
  const [folderSettingsDialog, setFolderSettingsDialog] = useState<FolderSettingsState>(null);

  /** Unified Settings popup (epic 01KPGWTJCWVBQCCSQ8NGSB19KQ) — opens
   *  via the gear "Settings" entry. */
  const [settingsDialog, setSettingsDialog] = useState<SettingsState>(null);

  /** Active Workflows popup target — opens when the user clicks Edit
   *  on a workflow row inside FolderSettingsDialog's Auto-code tab,
   *  OR clicks "+ New workflow" there. */
  const [autoCodePopupFolder, setAutoCodePopupFolder] = useState<AutoCodePopupState>(null);

  /** Note-level AI access dialog. Folder-level access has moved into
   *  FolderSettingsDialog (tab=ai-access); only note-level uses the
   *  standalone MCPPermissionsDialog now. */
  const [aiAccessTarget, setAiAccessTarget] = useState<AiAccessState>(null);

  /** Import (Phase 1) — trigger dialog opens via HeaderMenu, then on
   *  successful start we flip to the progress modal until the batch
   *  completes. */
  const [importTriggerOpen, setImportTriggerOpen] = useState(false);
  const [appleNotesOpen, setAppleNotesOpen] = useState(false);
  const [importBatchId, setImportBatchId] = useState<string | null>(null);

  /**
   * Open the AI Access dialog for a NOTE. Folder-level AI access has
   * moved into FolderSettingsDialog (tab=ai-access); only notes still
   * use the standalone dialog.
   */
  const requestAIAccess = useCallback(
    (target: { kind: 'note'; note: Note; folder: Folder | null }) => {
      setAiAccessTarget(target);
    },
    [],
  );

  /**
   * Refresh notes after a successful AI access save so the next open
   * reflects the latest per-note perms. Folder perms refresh via
   * FolderSettingsDialog directly; this callback is note-only.
   */
  const onAIAccessSaved = useCallback(
    (_updated: Folder | Note) => {
      refreshNotes().catch(console.error);
    },
    [refreshNotes],
  );

  return {
    folderSettingsDialog,
    setFolderSettingsDialog,
    settingsDialog,
    setSettingsDialog,
    autoCodePopupFolder,
    setAutoCodePopupFolder,
    aiAccessTarget,
    setAiAccessTarget,
    importTriggerOpen,
    setImportTriggerOpen,
    appleNotesOpen,
    setAppleNotesOpen,
    importBatchId,
    setImportBatchId,
    requestAIAccess,
    onAIAccessSaved,
  };
}

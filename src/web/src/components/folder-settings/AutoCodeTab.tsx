import {
  type ConciergeFolderSettings,
  type Folder,
} from '../../lib/api';
import { BlockedBanner } from './banners';
import { AutoCodeMainSection } from './auto-code/AutoCodeMainSection';
import { AutoCodeIntakeSection } from './auto-code/AutoCodeIntakeSection';
import { AutoCodeMergeSection } from './auto-code/AutoCodeMergeSection';

/**
 * Per-folder Auto-code settings tab. Unified under FolderSettingsDialog
 * (previously the standalone AutoCodePopup). The DAG editor for
 * individual workflows still lives in the separate Workflows popup —
 * opened on demand via `onOpenWorkflowsPopup`. This tab carries the
 * picker + edit/new affordances; the editor pane needs full-screen for
 * the react-flow canvas, so it doesn't fit inside this dialog.
 *
 * Composes three sections (each in its own module under `auto-code/`):
 *
 *   - AutoCodeMainSection       — master toggle, linked repo, active
 *                                 workflow picker (uses WorkflowDropdown)
 *   - AutoCodeIntakeSection     — folder-level override for mo_start
 *                                 intake rule
 *   - AutoCodeMergeSection      — auto-merge on done toggle
 *
 * The list of workflows themselves lives on the separate "Workflows"
 * tab — see WorkflowsTab.tsx (ticket 01KRYB4RV660RREP8XHNPT651B). Only
 * the active-workflow picker stays here; the picker still belongs to
 * Auto-code because it's the runtime selection, not the catalog.
 */
export function AutoCodeTab({
  folder,
  conciergeSettings,
  onConciergeUpdated,
  blockedReason,
}: {
  folder: Folder;
  conciergeSettings: ConciergeFolderSettings | null;
  onConciergeUpdated: (next: ConciergeFolderSettings) => void;
  blockedReason: string | null;
}) {
  const tabBlocked = blockedReason !== null;
  const moEnabled = conciergeSettings?.enabled ?? false;
  const autoCodeEnabled = conciergeSettings?.autoCodeEnabled ?? false;

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold">Auto-code</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Drag a ticket to <code>todo</code> → Mo runs the default
          workflow on it (or the ticket's own workflow if it has one
          pinned via the auto-code drawer). Up to 5 tickets in flight
          per folder.
        </p>
      </header>

      {tabBlocked && (
        <BlockedBanner
          reason={blockedReason!}
          hint="Re-enable MCP & Mo Access on Access Permissions to unlock."
        />
      )}

      {!tabBlocked && !moEnabled && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-700 dark:text-amber-400">
          Auto-code requires AI Data Indexing to be on for this folder.
          Flip "AI Data Indexing" on Access Permissions first.
        </div>
      )}

      {conciergeSettings && (
        <>
          <AutoCodeMainSection
            folderId={folder.id}
            settings={conciergeSettings}
            onSettingsChange={onConciergeUpdated}
            moEnabled={moEnabled}
            disabled={tabBlocked}
          />
          <div className="border-t border-border" />
          <AutoCodeIntakeSection
            folderId={folder.id}
            settings={conciergeSettings}
            onSettingsChange={onConciergeUpdated}
            disabled={tabBlocked || !autoCodeEnabled}
          />
          <div className="border-t border-border" />
          <AutoCodeMergeSection
            folderId={folder.id}
            settings={conciergeSettings}
            onSettingsChange={onConciergeUpdated}
            disabled={tabBlocked || !autoCodeEnabled}
          />
        </>
      )}
    </div>
  );
}

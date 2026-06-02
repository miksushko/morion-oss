import { type ConciergeFolderSettings, type Folder } from '../../lib/api';
import { BlockedBanner } from './banners';
import { FolderWorkflowsSection } from './auto-code/FolderWorkflowsSection';

/**
 * Per-folder Workflows tab. Hosts the full workflow list (was previously
 * a section at the bottom of the Auto-code tab — buried after master
 * toggle / intake / merge sections). The Active workflow picker stays
 * on the Auto-code tab; this tab is purely list + create / edit /
 * more-menu mutations on the workflow definitions themselves.
 *
 * Gating mirrors the Auto-code tab: Pro-only feature + greyed when the
 * folder is hidden from Mo (no Mo, no auto-code).
 *
 * Ticket: 01KRYB4RV660RREP8XHNPT651B
 */
export function WorkflowsTab({
  folder,
  conciergeSettings,
  blockedReason,
  onOpenWorkflowsPopup,
}: {
  folder: Folder;
  conciergeSettings: ConciergeFolderSettings | null;
  blockedReason: string | null;
  onOpenWorkflowsPopup?: (workflowId: string | null) => void;
}) {
  const tabBlocked = blockedReason !== null;
  const moEnabled = conciergeSettings?.enabled ?? false;

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold">Workflows</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          DAGs the Auto-code runner can dispatch on tickets in this
          folder. Pick the active one on the <em>Auto-code</em> tab.
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
        <FolderWorkflowsSection
          folderId={folder.id}
          onOpenWorkflowsPopup={onOpenWorkflowsPopup}
          disabled={tabBlocked}
        />
      )}
    </div>
  );
}

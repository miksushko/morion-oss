import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
  api,
  type Folder,
  type FolderMcpPermissions,
  type ConciergeFolderSettings,
  type ConciergeProviderStatus,
} from '../lib/api';
import {
  FOLDER_TAB_SPECS,
  FolderTabButton,
  type FolderSettingsTab,
} from './folder-settings/FolderTabNav';
import { GeneralTab } from './folder-settings/GeneralTab';
import { AiAccessTab } from './folder-settings/AiAccessTab';
import { IndexedSummaryTab } from './folder-settings/IndexedSummaryTab';
import { TopicsTab } from './folder-settings/TopicsTab';
import { AutoCodeTab } from './folder-settings/AutoCodeTab';
import { WorkflowsTab } from './folder-settings/WorkflowsTab';

export type { FolderSettingsTab };

/**
 * Unified per-folder settings popup — modeled on the workspace-level
 * `<SettingsDialog>` shipped in epic 01KPGWTJCWVBQCCSQ8NGSB19KQ.
 * Replaces the two previously-separate surfaces (legacy folder Mo
 * settings + standalone Auto-code popup). Five vertical tabs grouped
 * into Folder / Folder Memory / Automation:
 *
 *   1. General        — folder name + appearance (folder/kanban) +
 *                       archive + export to .md
 *   2. Access         — MCP & Mo Access permissions + AI Data
 *                       Indexing toggle (formerly "Enable Mo")
 *   3. Indexed Summary— catalog `overview` section + Tier 2.5 risks
 *                       (formerly Project Summary + Project Risks)
 *   4. Indexed Topics — per-folder clusters Mo discovered + topic
 *                       editor + cleanup engine (formerly Tasks Topics)
 *   5. Auto-code      — per-folder auto-code toggle + linked repo +
 *                       active workflow + Folder Auto-code Workflows
 *                       list (workflow rows open the full-screen
 *                       Workflows DAG-editor popup on edit)
 *
 * Access gate cascades to Indexed Summary / Topics / Auto-code:
 * if the folder is hidden from AI, Mo can't read it, and Mo-dependent
 * tabs surface a "Folder hidden from AI" banner with an inline
 * unblock toggle.
 *
 * Autosave everywhere — toggles are instant, text fields debounce
 * 500ms. No Save buttons; matches the rest of the app
 * (Apple-Notes-style implicit save).
 */

export interface FolderSettingsDialogProps {
  folder: Folder;
  initialTab?: FolderSettingsTab;
  onClose: () => void;
  onFolderUpdated: (folder: Folder) => void;
  /** Click-through from "Mo needs a model first" banner — parent flips
   * to Ask Mo + opens the gear-popover provider section. */
  onOpenWorkspaceMoSettings?: () => void;
  /** Open the (separate, full-screen) Workflows popup for this folder.
   * Pass workflowId to focus a specific workflow; pass null to land
   * the popup on the workflow list with no preselection. The popup is
   * full-screen so the DAG canvas has room — it doesn't belong
   * inside this settings dialog. */
  onOpenWorkflowsPopup?: (workflowId: string | null) => void;
}

export function FolderSettingsDialog({
  folder,
  initialTab = 'general',
  onClose,
  onFolderUpdated,
  onOpenWorkspaceMoSettings,
  onOpenWorkflowsPopup,
}: FolderSettingsDialogProps) {
  const [tab, setTab] = useState<FolderSettingsTab>(initialTab);
  // Reset scroll on tab switch — without this, switching from a long
  // tab (Indexed Topics editor / Auto-code) leaves the next tab
  // scrolled to the same offset, dropping the user mid-content. Same
  // pattern as `<SettingsDialog>` (lessons.md "Tab body scroll resets
  // to top on tab switch").
  const tabBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tabBodyRef.current) {
      tabBodyRef.current.scrollTop = 0;
    }
  }, [tab]);

  const [perms, setPerms] = useState<FolderMcpPermissions>(folder.mcpPermissions);
  const [conciergeSettings, setConciergeSettings] = useState<ConciergeFolderSettings | null>(null);
  const [provider, setProvider] = useState<ConciergeProviderStatus | null>(null);
  const [savingPerms, setSavingPerms] = useState(false);
  const [permsError, setPermsError] = useState<string | null>(null);

  // Initial fetch — load Mo settings + provider status. Permissions
  // come in via props (folder.mcpPermissions) so the dialog renders
  // immediately on the Access Permissions tab without a spinner.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [s, p] = await Promise.all([
          api.getConciergeFolderSettings(folder.id),
          api.getConciergeProvider().catch(() => null),
        ]);
        if (!alive) return;
        setConciergeSettings(s);
        setProvider(p);
      } catch (e) {
        if (alive) setPermsError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [folder.id]);

  // Escape closes the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Save folder permissions — instant on every toggle change.
  // We optimistic-update local state and rollback on error.
  const onPermsChange = async (next: FolderMcpPermissions) => {
    const prev = perms;
    setPerms(next);
    setSavingPerms(true);
    setPermsError(null);
    try {
      const updated = await api.setFolderPermissions(folder.id, next);
      onFolderUpdated(updated);
    } catch (e) {
      setPerms(prev);
      const raw = (e as Error).message ?? String(e);
      setPermsError(raw.replace(/^[A-Z]+ \/[^\s]+ failed: \d+: ?/, ''));
    } finally {
      setSavingPerms(false);
    }
  };

  const visibleToAi = perms.visible;
  const moEnabled = conciergeSettings?.enabled ?? false;
  const hasProviderKey = provider?.hasApiKey === true;
  const canEnableMo = visibleToAi && hasProviderKey;

  const moTabsBlockedReason: string | null = !visibleToAi
    ? 'Folder is hidden from AI'
    : null;

  // Mo enable mutation lives at the dialog level so all three tabs
  // can flip the switch — AI Access has the canonical row, the Mo
  // tabs surface an inline toggle inside their "Mo not enabled"
  // banner so users don't have to hop tabs to turn Mo on.
  const [savingMo, setSavingMo] = useState(false);
  const [moError, setMoError] = useState<string | null>(null);
  const onToggleMo = async (next: boolean) => {
    if (next && !canEnableMo) return;
    if (!conciergeSettings) return;
    setSavingMo(true);
    setMoError(null);
    try {
      const updated = await api.putConciergeFolderSettings(conciergeSettings.folderId, {
        enabled: next,
      });
      setConciergeSettings(updated);
    } catch (e) {
      setMoError((e as Error).message);
    } finally {
      setSavingMo(false);
    }
  };

  const dialog = (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/60 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-settings-title"
      onClick={onClose}
    >
      <div
        className="relative mt-10 flex w-full max-w-5xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        style={{ height: 'min(720px, calc(100vh - 80px))' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Vertical tab nav with optional group headers. Mirrors the
            workspace-level <SettingsDialog> nav (w-56). */}
        <nav
          className="w-56 shrink-0 overflow-y-auto border-r border-border bg-background/40 px-2 py-3"
          aria-label="Folder settings sections"
        >
          <div className="mb-3 px-2">
            <div id="folder-settings-title" className="truncate text-[11px] font-medium text-muted-foreground">
              "{folder.name}"
            </div>
          </div>
          <ul role="tablist" aria-orientation="vertical" className="flex flex-col gap-0.5">
            {FOLDER_TAB_SPECS.map((spec) => (
              <FolderTabButton
                key={spec.key}
                spec={spec}
                active={tab === spec.key}
                blocked={
                  spec.gatedByAccess === true && moTabsBlockedReason !== null
                }
                onClick={() => setTab(spec.key)}
              />
            ))}
          </ul>
        </nav>

        {/* Tab body */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>

          <div
            ref={tabBodyRef}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6"
          >
            {tab === 'general' && (
              <GeneralTab
                folder={folder}
                onFolderUpdated={onFolderUpdated}
                onClose={onClose}
              />
            )}
            {tab === 'access' && (
              <AiAccessTab
                perms={perms}
                onPermsChange={onPermsChange}
                permsError={permsError}
                savingPerms={savingPerms}
                moEnabled={moEnabled}
                canEnableMo={canEnableMo}
                hasProviderKey={hasProviderKey}
                visibleToAi={visibleToAi}
                savingMo={savingMo}
                moError={moError}
                onToggleMo={onToggleMo}
                onOpenWorkspaceMoSettings={onOpenWorkspaceMoSettings}
                onProviderRefetch={async () => {
                  try {
                    const p = await api.getConciergeProvider();
                    setProvider(p);
                  } catch {
                    /* offline, keep last */
                  }
                }}
              />
            )}
            {tab === 'summary' && (
              <IndexedSummaryTab
                folderId={folder.id}
                blockedReason={moTabsBlockedReason}
                conciergeSettings={conciergeSettings}
                moEnabled={moEnabled}
                canEnableMo={canEnableMo}
                savingMo={savingMo}
                onToggleMo={onToggleMo}
                onConciergeUpdated={setConciergeSettings}
              />
            )}
            {tab === 'topics' && (
              <TopicsTab
                folderId={folder.id}
                blockedReason={moTabsBlockedReason}
                moEnabled={moEnabled}
                canEnableMo={canEnableMo}
                savingMo={savingMo}
                onToggleMo={onToggleMo}
                conciergeSettings={conciergeSettings}
                onConciergeUpdated={setConciergeSettings}
              />
            )}
            {tab === 'auto-code' && (
              <AutoCodeTab
                folder={folder}
                conciergeSettings={conciergeSettings}
                onConciergeUpdated={setConciergeSettings}
                blockedReason={moTabsBlockedReason}
              />
            )}
            {tab === 'workflows' && (
              <WorkflowsTab
                folder={folder}
                conciergeSettings={conciergeSettings}
                blockedReason={moTabsBlockedReason}
                onOpenWorkflowsPopup={onOpenWorkflowsPopup}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}



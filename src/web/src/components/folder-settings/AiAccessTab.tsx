import { type FolderMcpPermissions } from '../../lib/api';
import { FolderToggles } from '../MCPPermissionsDialog';
import { SwitchRow } from '../SwitchRow';
import { NoKeyBanner } from './banners';

/**
 * AI Access tab (rendered as "Access Permissions" in nav). Owns the
 * FolderToggles + the AI Data Indexing master switch. Lifted from
 * FolderSettingsDialog without behaviour changes — every callback
 * still routes through the parent so save semantics and rollback
 * stay centralised.
 */
export function AiAccessTab({
  perms,
  onPermsChange,
  permsError,
  savingPerms,
  moEnabled,
  canEnableMo,
  hasProviderKey,
  visibleToAi,
  savingMo,
  moError,
  onToggleMo,
  onOpenWorkspaceMoSettings,
  onProviderRefetch,
}: {
  perms: FolderMcpPermissions;
  onPermsChange: (next: FolderMcpPermissions) => Promise<void>;
  permsError: string | null;
  savingPerms: boolean;
  moEnabled: boolean;
  canEnableMo: boolean;
  hasProviderKey: boolean;
  visibleToAi: boolean;
  savingMo: boolean;
  moError: string | null;
  onToggleMo: (next: boolean) => Promise<void>;
  onOpenWorkspaceMoSettings?: () => void;
  onProviderRefetch: () => Promise<void>;
}) {
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold">Access Permissions</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Control who can see and act in this folder — external MCP
          agents and Mo (the in-app indexer). Your own access in this
          app is unaffected.
        </p>
      </header>

      <section>
        <FolderToggles perms={perms} onChange={(next) => void onPermsChange(next)} />
        {savingPerms && (
          <div className="mt-2 text-[11px] text-muted-foreground">Saving…</div>
        )}
        {permsError && (
          <div className="mt-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            {permsError}
          </div>
        )}
      </section>

      <div className="border-t border-border" />

      {/* Mo master toggle uses the SAME SwitchRow primitive as the
          permissions above, so the layout doesn't look "ripped from
          two different places". The "Mo Concierge" subhead used to
          live here but was redundant — the row label already names
          the feature. The divider above is enough separation. */}
      <section className="space-y-3">
        {!hasProviderKey && (
          <NoKeyBanner onOpen={onOpenWorkspaceMoSettings} onRefresh={onProviderRefetch} />
        )}

        {!visibleToAi && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-[11px] text-amber-700 dark:text-amber-400">
            Folder is hidden from AI. Mo can't read it, so the Indexed
            Summary, Indexed Topics, and Auto-code tabs are inactive.
            Re-enable "MCP &amp; Mo Access" above to unlock them.
          </div>
        )}

        <SwitchRow
          label="AI Data Indexing"
          hint={
            !visibleToAi
              ? 'Disabled while folder is hidden from AI.'
              : !hasProviderKey
                ? 'Disabled until a model is configured above.'
                : 'Mo runs background indexing here — per-note summaries + keywords, per-topic aggregator notes, and a folder catalog — so Ask Mo can answer questions about this folder with cited sources. No autonomous comments or kanban moves.'
          }
          checked={moEnabled}
          onChange={(v) => void onToggleMo(v)}
          disabled={!canEnableMo && !moEnabled}
        />
        {savingMo && <div className="text-[11px] text-muted-foreground">Saving…</div>}
        {moError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            {moError}
          </div>
        )}
      </section>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import {
  api,
  type AuditEntry,
  type CommentsSettings,
  type McpSettings,
  type RuntimeInfo,
  type SettingsResponse,
} from '../lib/api';
import { GeneralTab } from './settings/GeneralTab';
import { LimitsTab } from './settings/LimitsTab';
import { LogsTab } from './settings/LogsTab';
import { McpServerTab } from './settings/McpServerTab';
import { MoAgentTab } from './settings/MoAgentTab';
import { SettingsTabButton } from './settings/SettingsTabButton';
import { SkillsTab } from './settings/SkillsTab';
import { UsageTab } from './settings/UsageTab';
import {
  TAB_SPECS,
  type SettingsDialogProps,
  type SettingsTab,
} from './settings/types';

export type { SettingsTab, SettingsDialogProps } from './settings/types';

/**
 * Workspace-level Settings — the unified popup that replaces the three
 * previously-scattered surfaces (`SettingsPanel` full route /
 * `SubscriptionPanel` full route / `MoSettingsDialog` modal).
 *
 * Modeled on `MoSettingsDialog` (portal + vertical tab nav + Esc close +
 * backdrop click) per epic 01KPGWTJCWVBQCCSQ8NGSB19KQ.
 *
 * Composition shell only — every tab lives under
 * `src/web/src/components/settings/`. When adding a tab, prefer a new
 * `<Foo>Tab.tsx` file there + a new entry in `TAB_SPECS` over inline
 * state/JSX here. The shell only owns the data that two-or-more tabs
 * share (currently the MCP settings + audit feed consumed by both
 * MCP Server and Logs tabs).
 */
export function SettingsDialog({
  initialTab = 'general',
  onClose,
  onCheckForUpdates,
  onRefreshData,
  onMcpStateChange,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  // Reset scroll on tab switch — without this, switching from a long
  // tab (Mo Agent / MCP Server) leaves the next tab scrolled to the
  // same offset, dropping the user mid-content. The scrollable
  // container is the per-tab body div below.
  const tabBodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tabBodyRef.current) {
      tabBodyRef.current.scrollTop = 0;
    }
  }, [tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Shared MCP-related data loaded eagerly on dialog mount. Three tabs
  // (MCP Server / Skills / Logs) consume slices. SkillsTab is
  // self-fetching via skillsApi, so it doesn't need anything from here
  // — but McpServerTab + LogsTab share a single fetch instead of
  // duplicating the GET /api/settings + GET /api/audit/mcp dance.
  const [mcpData, setMcpData] = useState<SettingsResponse | null>(null);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [mcpError, setMcpError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getSettings()
      .then((s) => {
        if (!alive) return;
        setMcpData(s);
        onMcpStateChange?.(s.mcp);
      })
      .catch((e) => alive && setMcpError(String(e)));
    api
      .getRuntime()
      .then((r) => alive && setRuntime(r))
      .catch((e) => alive && setMcpError(String(e)));
    api
      .getMcpAudit(50)
      .then((a) => alive && setAudit(a))
      .catch(() => alive && setAudit([]));
    return () => {
      alive = false;
    };
  }, [onMcpStateChange]);

  const refreshAudit = useCallback(() => {
    api
      .getMcpAudit(50)
      .then(setAudit)
      .catch(() => setAudit([]));
  }, []);

  const patchMcp = useCallback(
    async (next: {
      enabled?: boolean;
      categories?: Partial<McpSettings['categories']>;
    }) => {
      // Optimistic local update so the toggle responds instantly.
      setMcpData((cur) => {
        if (!cur) return cur;
        return {
          ...cur,
          mcp: {
            enabled: next.enabled ?? cur.mcp.enabled,
            categories: { ...cur.mcp.categories, ...(next.categories ?? {}) },
          },
        };
      });
      try {
        const updated = await api.updateSettings({ mcp: next });
        setMcpData((cur) => (cur ? { ...cur, mcp: updated.mcp } : cur));
        onMcpStateChange?.(updated.mcp);
      } catch (e) {
        setMcpError(String(e));
        const fresh = await api.getSettings();
        setMcpData(fresh);
        onMcpStateChange?.(fresh.mcp);
      }
    },
    [onMcpStateChange],
  );

  const patchComments = useCallback(async (next: Partial<CommentsSettings>) => {
    setMcpData((cur) => {
      if (!cur) return cur;
      return { ...cur, comments: { ...cur.comments, ...next } };
    });
    try {
      const updated = await api.updateSettings({ comments: next });
      setMcpData((cur) =>
        cur ? { ...cur, comments: updated.comments } : cur,
      );
    } catch (e) {
      setMcpError(String(e));
      const fresh = await api.getSettings();
      setMcpData(fresh);
    }
  }, []);

  const dialog = (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/60 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
      onClick={onClose}
    >
      <div
        className="relative mt-10 flex w-full max-w-[960px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        style={{ height: 'min(720px, calc(100vh - 80px))' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Vertical tab nav with optional group headers. Wider rail
            (w-56) than MoSettingsDialog (w-48) to fit longer labels
            like "MCP Server" + the leading icon column. */}
        <nav
          className="w-56 shrink-0 overflow-y-auto border-r border-border bg-background/40 px-2 py-3"
          aria-label="Settings sections"
        >
          <div className="mb-3 px-2">
            <div
              id="settings-dialog-title"
              className="truncate text-[11px] font-medium text-muted-foreground"
            >
              Settings
            </div>
          </div>
          <ul role="tablist" aria-orientation="vertical" className="flex flex-col gap-0.5">
            {TAB_SPECS.map((spec) => (
              <SettingsTabButton
                key={spec.key}
                spec={spec}
                active={tab === spec.key}
                onClick={() => setTab(spec.key)}
              />
            ))}
          </ul>
        </nav>

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
            className="flex min-h-0 flex-1 flex-col overflow-y-auto p-8"
          >
            {tab === 'general' && (
              <GeneralTab
                onCheckForUpdates={onCheckForUpdates}
                onRefreshData={onRefreshData}
                runtime={runtime}
              />
            )}
            {tab === 'limits' && <LimitsTab />}
            {tab === 'usage' && <UsageTab />}
            {tab === 'mo-agent' && <MoAgentTab />}
            {tab === 'mcp-server' && (
              <McpServerTab
                data={mcpData}
                runtime={runtime}
                audit={audit}
                error={mcpError}
                onPatch={patchMcp}
                onPatchComments={patchComments}
                onRefreshAudit={refreshAudit}
              />
            )}
            {tab === 'skills' && <SkillsTab />}
            {tab === 'logs' && (
              <LogsTab audit={audit} onRefresh={refreshAudit} error={mcpError} />
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
}

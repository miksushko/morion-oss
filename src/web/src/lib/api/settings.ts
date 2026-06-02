import { request } from './http';
import type {
  AuditEntry,
  CommentsSettings,
  InstallClientsResponse,
  InstallMutationResult,
  McpCategoryGates,
  McpSettings,
  RuntimeInfo,
  SettingsResponse,
  TermsInfo,
  UsagePeriod,
  UsageResponse,
} from './types';

/**
 * Workspace settings, runtime info, audit, usage stats, terms consent,
 * Mo workspace memory, and MCP-client install.
 *
 * Lumped together because each is small (1-3 methods) and they share an
 * "admin / workspace metadata" character — none of them operate on
 * individual notes or folders.
 */
export const settingsApi = {
  getSettings: () => request<SettingsResponse>('/api/settings'),
  updateSettings: (patch: {
    mcp?: { enabled?: boolean; categories?: Partial<McpCategoryGates> };
    comments?: Partial<CommentsSettings>;
  }) =>
    request<{ mcp: McpSettings; comments: CommentsSettings }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** First-run Terms consent. Body must carry the version string the
   *  UI rendered — the server refuses mismatched versions with a 400
   *  `terms_version_mismatch`. On success returns the fresh TermsInfo. */
  acceptTerms: (version: string) =>
    request<TermsInfo>('/api/settings/accept-terms', {
      method: 'POST',
      body: JSON.stringify({ version }),
    }),
  getRuntime: () => request<RuntimeInfo>('/api/runtime'),
  /** Sidecar health + version. Auth-aware (Tauri prod sidecar is
   *  token-gated) so this works in the desktop app as well as dev. */
  getHealth: () => request<{ ok: boolean; version: string }>('/api/health'),
  getMcpAudit: (limit = 50) => request<AuditEntry[]>(`/api/audit/mcp?limit=${limit}`),

  // ---- Usage stats (Settings → Usage tab, ticket 01KRJSTN74FT7VRX6KAA42GGBS)
  /** Aggregate LLM spend + cap status for the chosen window. Reads
   *  the local `mo_spend_ledger`; open on Free (empty ledger renders
   *  as zeros + provider dashboard links, no 402 wall). */
  getUsage: (period: UsagePeriod = 'current_month') =>
    request<UsageResponse>(`/api/usage?period=${encodeURIComponent(period)}`),

  // ---- Mo workspace memory --------------------------------------------
  getMoMemory: () => request<{ body: string }>('/api/mo/memory'),
  putMoMemory: (body: string) =>
    request<{ ok: true; body: string }>('/api/mo/memory', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    }),

  // One-click install of Morion into known LLM client config files.
  // The sidecar reads/writes the user's actual ~/.cursor/mcp.json,
  // ~/.claude.json etc — so always backup-first, atomic, refuse on
  // malformed JSON. See src/core/mcp-install/installer.ts.
  listInstallClients: () => request<InstallClientsResponse>('/api/install/clients'),
  installClient: (id: string) =>
    request<InstallMutationResult>(`/api/install/${id}`, { method: 'POST' }),
  uninstallClient: (id: string) =>
    request<InstallMutationResult>(`/api/install/${id}`, { method: 'DELETE' }),
};

import { useCallback, useEffect, useState } from 'react';
import { api, type McpSettings } from '../lib/api';

/**
 * MCP master toggle + "Review MCP access" mode.
 *
 *   - `mcpEnabled` — Sidebar dot reflects the master MCP toggle in
 *     real time. Defaults to enabled so the dot doesn't flicker grey
 *     on first paint. SettingsPanel pushes updates via
 *     `handleMcpStateChange`.
 *   - `reviewMcp` — when on, folder/note rows grow a compact V/C/E/D
 *     glyph strip so the user can audit permissions at a glance
 *     without opening each dialog. Default off — review is an opt-in
 *     power tool, not everyday chrome. Toggle lives in the gear menu.
 *
 * Initial fetch is best-effort: if `/api/settings` is unreachable,
 * the dot stays in its default state. The terms-gate fetch in
 * `useTermsGate` re-queries `/api/settings` separately on `envReady`.
 */
export function useMcpSettings() {
  const [mcpEnabled, setMcpEnabled] = useState<boolean>(true);
  const [reviewMcp, setReviewMcp] = useState<boolean>(false);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setMcpEnabled(s.mcp.enabled))
      .catch(() => {
        // Settings endpoint not available — leave the dot in its default state.
      });
  }, []);

  const handleMcpStateChange = useCallback((mcp: McpSettings) => {
    setMcpEnabled(mcp.enabled);
  }, []);

  return { mcpEnabled, reviewMcp, setReviewMcp, handleMcpStateChange };
}

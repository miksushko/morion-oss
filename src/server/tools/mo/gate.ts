import type { ToolContext } from '../types.js';

/**
 * Shared gate helper for the `mo_*` MCP tool family (Mo Context Broker).
 *
 * **Per-folder Mo-enabled** — Mo's blast radius is scoped to folders the
 * user has explicitly opted in via folder settings. Reuses the existing
 * `concierge_folder_settings.enabled` flag that gates the scheduler, so the
 * user's mental model stays single: "Enable Mo on this folder" governs BOTH
 * the autonomous scheduler ticks AND the agent-driven `mo_*` tool surface.
 *
 * Every folder-scoped `mo_*` tool MUST go through `requireMoEnabledForFolder`
 * rather than inline its own check. (Mo is free in the open-source build —
 * there is no license gate; the per-folder opt-in is the only gate.)
 */

export const MO_ACCESS_DENIED_NOT_ENABLED = {
  error: 'mcp_access_denied',
  reason: 'mo_not_enabled_for_folder',
  message:
    'Mo is not enabled for this folder. Open the folder in Morion → settings → AI Access → Enable Mo. Until then, `mo_*` tools cannot read or write anything in this folder.',
} as const;

export const MO_INTERNAL_NOT_WIRED = {
  error: 'mo_internal',
  reason: 'concierge_not_wired',
  message:
    'Mo subsystem is not available in this MCP context. This is a packaging bug — restart Morion or update the desktop app.',
} as const;

export type MoGateDenial =
  | typeof MO_ACCESS_DENIED_NOT_ENABLED
  | typeof MO_INTERNAL_NOT_WIRED;

/**
 * Per-folder Mo-enabled gate. Returns:
 *   - `MO_INTERNAL_NOT_WIRED` if the MCP context wasn't built with the
 *     concierge bag (programming error in the MCP startup wiring).
 *   - `MO_ACCESS_DENIED_NOT_ENABLED` if the folder exists but Mo is off.
 *   - `null` to allow.
 *
 * Default `concierge_folder_settings.enabled` is `false`, so a folder
 * the user has never touched correctly fails closed — Mo isn't allowed
 * to assume opt-in.
 */
export function requireMoEnabledForFolder(
  ctx: ToolContext,
  folderId: string,
): typeof MO_ACCESS_DENIED_NOT_ENABLED | typeof MO_INTERNAL_NOT_WIRED | null {
  if (!ctx.concierge) return MO_INTERNAL_NOT_WIRED;
  const settings = ctx.concierge.folderSettings.getOrDefault(folderId);
  if (!settings.enabled) return MO_ACCESS_DENIED_NOT_ENABLED;
  return null;
}

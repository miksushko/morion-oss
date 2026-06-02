/**
 * Mirrors `PENDING_TOOL_MARKER` in `src/core/concierge/chat-approvals.ts`.
 * Server pauses the chat tool-call loop on a destructive tool and
 * persists an assistant row whose content starts with this marker +
 * a JSON payload. UI detects the prefix and renders an approval card
 * instead of a regular bubble. Codex finding 01KQ1H5MKPBG7DY0730VRRW178.
 */
export const PENDING_TOOL_MARKER = '__MO_PENDING_TOOL_APPROVAL__';

export interface PendingToolPayload {
  preface: string;
  toolCalls: Array<{
    id: string;
    name: string;
    argumentsJson: string;
    /** Server-resolved human label for destructive calls — e.g.
     * "note 'Project spec'" or "folder 'Inbox', 12 notes". Optional;
     * UI falls back to mono args display when undefined. */
    displayLabel?: string;
  }>;
  destructiveCallIds: string[];
  model: string | null;
}

export function parsePendingTool(content: string): PendingToolPayload | null {
  if (!content.startsWith(PENDING_TOOL_MARKER)) return null;
  const tail = content.slice(PENDING_TOOL_MARKER.length).replace(/^\s+/u, '');
  try {
    const parsed = JSON.parse(tail) as PendingToolPayload;
    if (!Array.isArray(parsed.toolCalls)) return null;
    if (!Array.isArray(parsed.destructiveCallIds)) return null;
    return parsed;
  } catch {
    return null;
  }
}

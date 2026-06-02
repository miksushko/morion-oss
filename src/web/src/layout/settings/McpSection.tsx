import type { McpSettings } from '../../lib/api';
import { cn } from '../../lib/cn';
import { SectionHeader } from './SectionHeader';
import { Toggle } from './Toggle';

// ---------- 1. master MCP toggle ----------

export function McpSection({
  mcp,
  onPatch,
}: {
  mcp: McpSettings;
  onPatch: (next: { enabled?: boolean }) => Promise<void>;
}) {
  return (
    <section>
      <SectionHeader
        title="MCP server"
        blurb="Master switch for the Morion MCP server. When off, every tool call returns mcp_disabled and tools/list comes back empty after the next client reconnect."
      />
      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className={cn(
              'inline-block h-2.5 w-2.5 rounded-full',
              mcp.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40',
            )}
          />
          <div>
            <div className="text-sm font-medium text-foreground">
              {mcp.enabled ? 'Enabled' : 'Disabled'}
            </div>
            <div className="text-xs text-muted-foreground">
              {mcp.enabled
                ? 'LLM clients can read and write your notebook.'
                : 'LLM tool calls are blocked at the server.'}
            </div>
          </div>
        </div>
        <Toggle checked={mcp.enabled} onChange={(v) => onPatch({ enabled: v })} />
      </div>
    </section>
  );
}

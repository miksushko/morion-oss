import type {
  AuditEntry,
  CommentsSettings,
  McpSettings,
  RuntimeInfo,
  SettingsResponse,
} from '../../lib/api';
import {
  CategoriesSection,
  ClientsSection,
  CommentsSection,
  ConnectSection,
  McpSection,
} from '../../layout/SettingsPanel';
import { SectionDivider } from './leaf';

/**
 * MCP Server tab — five sections from the legacy SettingsPanel route,
 * minus the standalone Skills + Logs (which moved to their own tabs).
 * Sections: master MCP toggle, per-category permissions, comments
 * policy, install snippets, connected clients.
 *
 * Reuses the exported section components from SettingsPanel.tsx — data
 * fetching + patch handlers live one level up in SettingsDialog.
 */
export function McpServerTab({
  data,
  runtime,
  audit,
  error,
  onPatch,
  onPatchComments,
  onRefreshAudit,
}: {
  data: SettingsResponse | null;
  runtime: RuntimeInfo | null;
  audit: AuditEntry[];
  error: string | null;
  onPatch: (next: {
    enabled?: boolean;
    categories?: Partial<McpSettings['categories']>;
  }) => Promise<void>;
  onPatchComments: (next: Partial<CommentsSettings>) => Promise<void>;
  onRefreshAudit: () => void;
}) {
  return (
    <div className="flex flex-col gap-8">
      <header>
        <h2 className="text-lg font-semibold text-foreground">MCP Server</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          What AI clients can read / write through MCP, comments policy,
          install snippets, and the connected-clients audit.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      {!data ? (
        <p className="text-sm text-muted-foreground">Loading settings…</p>
      ) : (
        <>
          <McpSection mcp={data.mcp} onPatch={onPatch} />
          <SectionDivider />
          <CategoriesSection
            mcp={data.mcp}
            tools={data.toolsByCategory}
            onPatch={onPatch}
          />
          <SectionDivider />
          <CommentsSection
            comments={data.comments}
            onPatch={onPatchComments}
          />
          <SectionDivider />
          <ConnectSection runtime={runtime} />
          <SectionDivider />
          <ClientsSection audit={audit} onRefresh={onRefreshAudit} />
        </>
      )}
    </div>
  );
}

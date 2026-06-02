import type { AuditEntry } from '../../lib/api';
import { WhatMoDidSection } from '../../layout/SettingsPanel';

export function LogsTab({
  audit,
  onRefresh,
  error,
}: {
  audit: AuditEntry[];
  onRefresh: () => void;
  error: string | null;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-lg font-semibold text-foreground">Logs</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Recent MCP activity — what Mo and external AI assistants did on
          your notes. Limited to the last 50 actions.
        </p>
      </header>
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}
      <WhatMoDidSection audit={audit} onRefresh={onRefresh} />
    </div>
  );
}

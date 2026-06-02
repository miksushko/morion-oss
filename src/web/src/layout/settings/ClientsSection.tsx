import { useMemo } from 'react';
import type { AuditEntry } from '../../lib/api';
import { SectionHeader } from './SectionHeader';

export function ClientsSection({
  audit,
  onRefresh,
}: {
  audit: AuditEntry[];
  onRefresh: () => void;
}) {
  // Group by actor for the summary table.
  const summary = useMemo(() => {
    const m = new Map<string, { actor: string; count: number; lastSeen: number }>();
    for (const e of audit) {
      const cur = m.get(e.actor);
      if (cur) {
        cur.count += 1;
        if (e.timestamp > cur.lastSeen) cur.lastSeen = e.timestamp;
      } else {
        m.set(e.actor, { actor: e.actor, count: 1, lastSeen: e.timestamp });
      }
    }
    return [...m.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }, [audit]);

  return (
    <section>
      <div className="flex items-center justify-between">
        <SectionHeader
          title="Connected clients"
          blurb="Recent MCP activity from the audit log. Filtered to actors starting with mcp: — your own edits in this UI are excluded."
        />
        <button
          type="button"
          onClick={onRefresh}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Refresh
        </button>
      </div>
      {summary.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No MCP activity yet. Once a client connects and runs a tool, it shows up here.
        </p>
      )}
      {summary.length > 0 && (
        <div className="rounded-lg border border-border bg-card">
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Actor</th>
                <th className="px-4 py-2">Calls</th>
                <th className="px-4 py-2">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.actor} className="border-t border-border">
                  <td className="px-4 py-2 font-mono text-foreground">{row.actor}</td>
                  <td className="px-4 py-2 tabular-nums text-muted-foreground">{row.count}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {formatRelative(row.lastSeen)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api, type AuditEntry } from '../../lib/api';
import { SectionHeader } from './SectionHeader';

// ---------- 5. what Mo did (per-row audit + revert) ----------

/**
 * Row-level surface for "what Mo did". Distinct from Connected Clients
 * (which summarises by actor). This shows individual MCP write events
 * — newest first — and offers a one-click Trash button on creates that
 * still resolve to a live note (recoverable for 7 days via the trash
 * folder, so user can undo a hasty revert).
 *
 * Reverts beyond `create` (status_change, update, delete) are NOT
 * supported here in v1. Updates have no diff stored to roll back to;
 * status_change can be reversed via the kanban UI directly; deletes
 * are already recoverable in trash. Each of those rows just shows
 * what happened — the visibility itself is the UX win.
 *
 * Implementation note: we reuse the existing /api/audit/mcp endpoint
 * (which the Connected Clients section already consumes) instead of
 * adding a parallel endpoint. The same `audit` array drives both
 * sections; the parent component fetches once and re-renders both.
 */
export function WhatMoDidSection({
  audit,
  onRefresh,
}: {
  audit: AuditEntry[];
  onRefresh: () => void;
}) {
  // Hide read-only ops — they're noise for "what Mo CHANGED". The
  // server already filters to actor=mcp:* so all rows here are agent
  // writes by definition.
  const writes = useMemo(
    () => audit.filter((r) => r.action !== 'read'),
    [audit],
  );

  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trash = async (row: AuditEntry) => {
    if (!row.noteId) return;
    setBusyId(row.id);
    setError(null);
    try {
      await api.deleteNote(row.noteId);
      onRefresh();
    } catch (e) {
      // Most common failure: the note is already in trash (idempotent
      // delete returns ok in core, but a concurrent purge can 404).
      // Surface the message but keep the row visible — user can
      // refresh manually.
      setError(`Could not trash this note: ${(e as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <SectionHeader
        title="What Mo did"
        blurb="Per-row log of recent MCP write events. Trash on a `create` row soft-deletes the affected note (recoverable for 7 days). Updates / status changes / deletes are shown for visibility but not auto-revertible — fix them in the note's own UI."
      />
      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {writes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No MCP write activity yet. Once an agent calls a `mo_*` or `notes_*` write, it shows up here.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {/* `table-fixed` + explicit col widths prevents the Target
              cell's long note titles from blowing the table past its
              container. Target column takes the remaining space and
              wraps multi-line via `break-words` on the cell content
              (was: `truncate`, which clipped + sometimes overflowed
              the dialog). */}
          <table className="w-full table-fixed text-left text-xs">
            <colgroup>
              <col className="w-20" />
              <col className="w-24" />
              <col className="w-28" />
              <col />
              <col className="w-20" />
            </colgroup>
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Actor</th>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">Target</th>
                <th className="px-4 py-2 text-right">Revert</th>
              </tr>
            </thead>
            <tbody>
              {writes.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                    {formatRelative(row.timestamp)}
                  </td>
                  <td className="break-words px-4 py-2 font-mono text-foreground">
                    {row.actor}
                  </td>
                  <td className="break-words px-4 py-2 text-foreground">
                    {row.action === 'status_change' && row.statusFrom && row.statusTo
                      ? `${row.statusFrom} → ${row.statusTo}`
                      : row.action}
                  </td>
                  <td className="min-w-0 break-words px-4 py-2 text-foreground">
                    {row.noteTitle ? (
                      <span className="block break-words" title={row.noteTitle}>
                        {row.noteTitle}
                      </span>
                    ) : (
                      <span className="italic text-muted-foreground">(deleted)</span>
                    )}
                    {row.noteId && (
                      <code className="block break-all text-[10px] text-muted-foreground/70">
                        {row.noteId}
                      </code>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {row.action === 'create' && row.noteId && row.noteTitle ? (
                      <button
                        type="button"
                        onClick={() => void trash(row)}
                        disabled={busyId === row.id}
                        title="Move this Mo-created note to trash (recoverable for 7 days)"
                        className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" />
                        {busyId === row.id ? 'Trashing…' : 'Trash'}
                      </button>
                    ) : (
                      <span className="text-[11px] text-muted-foreground/50">—</span>
                    )}
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

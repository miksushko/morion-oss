import { useState } from 'react';
import { AlertTriangle, Check, Loader2, ShieldAlert, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { truncateArgs } from './truncate';
import type { PendingToolPayload } from './pendingTool';

/**
 * Approval card rendered in place of an assistant message when Mo
 * asked to call a destructive (delete-category) tool. Codex finding
 * 01KQ1H5MKPBG7DY0730VRRW178.
 *
 * Three states:
 *   - active: payload parsed, no tool result yet -> show buttons
 *   - resolved: tool result rows exist downstream -> show outcome chip,
 *     no buttons (already-decided idempotency)
 *   - malformed: payload couldn't parse -> render an error card so the
 *     transcript doesn't go silent
 */
export function PendingToolApprovalCard({
  payload,
  resolved,
  disabled,
  onDecide,
}: {
  payload: PendingToolPayload | null;
  resolved: boolean;
  disabled: boolean;
  onDecide: (decision: 'approve' | 'deny', reason?: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showDenyReason, setShowDenyReason] = useState(false);
  const [reason, setReason] = useState('');

  if (!payload) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4" />
          Pending tool call (malformed)
        </div>
        <div className="mt-1 text-[12px] opacity-90">
          Mo's pending-approval row failed to parse. Probably a server-side
          schema drift. The row stays in the transcript for forensics; click
          past it.
        </div>
      </div>
    );
  }

  const destructiveCalls = payload.toolCalls.filter((c) =>
    payload.destructiveCallIds.includes(c.id),
  );
  // Map tool name -> user-readable verb for the headline. Server already
  // resolved the target's title via displayLabel so we can read like
  // a sentence: "Delete note 'Project spec'" instead of dumping a ULID.
  const verb = (toolName: string): string => {
    switch (toolName) {
      case 'notes_delete': return 'Delete';
      case 'folders_delete': return 'Delete';
      case 'tags_delete': return 'Delete';
      case 'notes_delete_comment': return 'Delete';
      default: return toolName;
    }
  };

  const click = async (decision: 'approve' | 'deny') => {
    if (busy || disabled || resolved) return;
    if (decision === 'deny' && !showDenyReason) {
      setShowDenyReason(true);
      return;
    }
    setBusy(true);
    try {
      onDecide(decision, decision === 'deny' ? reason.trim() || undefined : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        'rounded-lg border p-4 text-sm',
        resolved
          ? 'border-border bg-muted/30 text-muted-foreground'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
      )}
    >
      <div className="mb-1 flex items-center gap-2 font-medium">
        <ShieldAlert className="h-4 w-4" />
        {resolved ? 'Tool call resolved' : 'Mo wants to run a destructive tool'}
      </div>
      {payload.preface && (
        <p className="text-[12px] opacity-90 italic">{payload.preface}</p>
      )}
      <ul className="mt-2 space-y-1.5">
        {destructiveCalls.length === 0 && (
          <li className="rounded-md bg-background/40 px-2.5 py-1.5 font-mono text-[11px] text-foreground/80">
            (no destructive calls in payload)
          </li>
        )}
        {destructiveCalls.map((c) => (
          <li
            key={c.id}
            className="rounded-md bg-background/40 px-2.5 py-1.5 text-[12px] text-foreground"
          >
            {c.displayLabel ? (
              <>
                <span className="font-medium">{verb(c.name)}</span>
                {' '}
                <span>{c.displayLabel}</span>
              </>
            ) : (
              // Fallback to raw mono args when the server couldn't
              // resolve the target (deleted between Mo emitting and
              // server persisting, malformed args, unknown tool).
              <span className="font-mono text-[11px] text-foreground/80">
                {c.name}({truncateArgs(c.argumentsJson)})
              </span>
            )}
          </li>
        ))}
      </ul>
      {!resolved && (
        <>
          {showDenyReason && (
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why? (optional, helps Mo adjust)"
              rows={2}
              className="mt-2 w-full rounded-md border border-amber-500/30 bg-background/60 px-2 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            />
          )}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void click('approve')}
              disabled={busy || disabled}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/20 px-3 py-1.5 text-[12px] font-medium text-emerald-800 hover:bg-emerald-500/30 disabled:opacity-50 dark:text-emerald-300"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Approve
            </button>
            <button
              type="button"
              onClick={() => void click('deny')}
              disabled={busy || disabled}
              className="inline-flex items-center gap-1.5 rounded-md bg-destructive/20 px-3 py-1.5 text-[12px] font-medium text-destructive hover:bg-destructive/30 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
              {showDenyReason ? 'Deny + send reason' : 'Deny'}
            </button>
            {showDenyReason && (
              <button
                type="button"
                onClick={() => {
                  setShowDenyReason(false);
                  setReason('');
                }}
                disabled={busy}
                className="text-[11px] text-muted-foreground hover:underline"
              >
                Cancel
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

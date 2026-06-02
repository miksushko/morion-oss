import { useEffect, useState } from 'react';
import { api, type AutoCodeQueueRow } from '../../lib/api';

/**
 * Phase 5 MVP — drawer CTA for `paused_ask_user` state. The run is
 * frozen waiting for the user to reply in the linked Ask Mo session.
 * This panel surfaces a clear "Open chat to reply" button so the user
 * doesn't have to dig through the Concierge sessions list to find it.
 *
 * Reads the linked session id from the workflow_runs row via a tiny
 * dedicated probe — the `AutoCodeQueueRow` shape returned by the
 * batch route doesn't carry `paused_session_id` directly (it's a
 * workflow-runs-only column the legacy shape never had a slot for).
 * Falls back to "open Ask Mo" generic link if the probe fails.
 */
export function PausedAskUserCTA({ row }: { row: AutoCodeQueueRow }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getAutoCodeRunPausedSession(row.id)
      .then((s) => {
        if (!cancelled) setSessionId(s);
      })
      .catch(() => {
        if (!cancelled) setSessionId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  const openChat = () => {
    if (sessionId) {
      window.location.hash = `#/concierge/sessions/${sessionId}`;
    } else {
      window.location.hash = '#/concierge';
    }
  };

  return (
    <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-sm">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="font-medium text-sky-700 dark:text-sky-300">
            ⏸️ Mo is waiting for your answer
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            The workflow paused at a Human-in-Loop stage. Open the linked Ask Mo
            chat to reply — the run resumes automatically once you do.
          </div>
        </div>
        <button
          type="button"
          onClick={openChat}
          className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
        >
          Open chat to reply
        </button>
      </div>
    </div>
  );
}

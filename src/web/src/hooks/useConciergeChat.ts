import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { AppView } from '../appShellTypes';

/**
 * Concierge chat plumbing lifted out of `ConciergePanel` so that:
 *   (a) the Stop button works (AbortControllers stored in a ref).
 *   (b) when the user switches view mid-reply, the thinking bubble
 *       and Stop button are still there when they return — the panel
 *       reads this state on mount.
 *   (c) the Ask Mo sidebar entry can show a pulse while any session
 *       is mid-reply, so the user knows Mo is still working in a
 *       different chat.
 *
 * Also owns the `needsHumanCount` badge fetch:
 *   - initial fetch when env is ready
 *   - refresh on view toggle (so opening Concierge clears/updates)
 *   - 30s periodic refresh matching the scheduler poll
 *   - opportunistic refresh after every `send` (a turn may have
 *     resolved an "awaiting user reply" chat).
 *
 * Client-side abort only for now: the fetch is cancelled, but the
 * server continues running the tool-call loop. That's acceptable
 * because (a) any real assistant message it eventually persists
 * arrives via the WAL watcher + list-messages refresh on next view,
 * and (b) a server-side cancel endpoint would need a per-session
 * inflight registry + checkpoints inside the tool loop — deferred
 * until V8 proxy reshapes the chat path anyway.
 */
export function useConciergeChat(envReady: boolean, view: AppView) {
  const [inflightSessionIds, setInflightSessionIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const abortersRef = useRef<Map<string, AbortController>>(new Map());
  const [needsHumanCount, setNeedsHumanCount] = useState(0);

  /** Session id to preselect on next mount of `ConciergePanel`. Set
   * when Mo's Launch → session_open returns a new chat id so the user
   * lands directly on it. Cleared by the panel after it consumes it. */
  const [preselectSessionId, setPreselectSessionId] = useState<string | null>(null);

  /** One-shot flag — set when the user clicks "Open Mo settings" in
   * the per-folder no-key banner (or NotConfiguredCTA chat reply).
   * ConciergePanel auto-opens the gear popover on mount when true,
   * then calls onAutoOpenConsumed to reset. */
  const [autoOpenSettings, setAutoOpenSettings] = useState(false);

  const refreshNeedsHumanCount = useCallback(() => {
    api
      .listConciergeSessions({ limit: 1 })
      .then((r) => setNeedsHumanCount(r.needsHumanCount))
      .catch(() => {
        /* Concierge endpoints are Pro-gated for mutations but the list
         * GET is open. A 404/501 here means the server predates V4 —
         * leave count at 0, the row still renders. */
      });
  }, []);

  // Initial fetch + 30s periodic refresh. Re-runs whenever the user
  // toggles into/out of Concierge view so the badge is fresh on
  // entry/exit.
  useEffect(() => {
    if (!envReady) return;
    let cancelled = false;
    const tick = () => {
      api
        .listConciergeSessions({ limit: 1 })
        .then((r) => {
          if (!cancelled) setNeedsHumanCount(r.needsHumanCount);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [envReady, view]);

  const send = useCallback(
    async (sessionId: string, content: string) => {
      // Replace any prior controller for this session (shouldn't exist
      // under normal flow — Composer disables Send while busy — but be
      // defensive).
      const prior = abortersRef.current.get(sessionId);
      if (prior) prior.abort();

      const controller = new AbortController();
      abortersRef.current.set(sessionId, controller);
      setInflightSessionIds((cur) => {
        const next = new Set(cur);
        next.add(sessionId);
        return next;
      });

      try {
        const resp = await api.sendConciergeMessage(sessionId, content, {
          signal: controller.signal,
        });
        // Bump needs-human + sidebar counts — the turn may have resolved
        // an "awaiting user reply" chat.
        refreshNeedsHumanCount();
        return resp;
      } finally {
        abortersRef.current.delete(sessionId);
        setInflightSessionIds((cur) => {
          if (!cur.has(sessionId)) return cur;
          const next = new Set(cur);
          next.delete(sessionId);
          return next;
        });
      }
    },
    [refreshNeedsHumanCount],
  );

  const stop = useCallback((sessionId: string) => {
    const controller = abortersRef.current.get(sessionId);
    if (!controller) return;
    controller.abort();
    // The finally-block in `send` cleans up state refs;
    // nothing else to do here. AbortError bubbles up to the caller
    // which should treat it as "user stopped".
  }, []);

  return {
    inflightSessionIds,
    needsHumanCount,
    refreshNeedsHumanCount,
    send,
    stop,
    preselectSessionId,
    setPreselectSessionId,
    autoOpenSettings,
    setAutoOpenSettings,
  };
}

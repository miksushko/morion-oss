import { useEffect, useState } from 'react';
import { api, type AutoCodeTranscriptPayload } from '../../lib/api';
import { getApiBaseSync, getApiToken } from '../../lib/env';
import type { DrawerSessionEntry } from './types';
import { sessionDepKey, sessionSelectorToApiArg } from './helpers';

export type TranscriptStatus = 'loading' | 'streaming' | 'closed' | 'error';

/** Live transcript hook — initial JSON fetch + SSE subscription with
 *  auto-reconnect backoff. Re-runs when rowId OR session identity
 *  changes (identity reduced to `sessionDepKey` so React effects
 *  don't fire on object-identity churn that doesn't change the URL). */
export function useAutoCodeTranscript(rowId: string, session: DrawerSessionEntry) {
  const [payload, setPayload] = useState<AutoCodeTranscriptPayload | null>(null);
  const [status, setStatus] = useState<TranscriptStatus>('loading');
  const depKey = sessionDepKey(session);
  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setStatus('loading');
    const apiSession = sessionSelectorToApiArg(session);

    // Initial JSON fetch so we paint instantly even if the SSE
    // stream takes a beat to open. SSE's first emit will overwrite
    // this with the same data — idempotent.
    api
      .getAutoCodeTranscript(rowId, apiSession)
      .then((p) => {
        if (cancelled) return;
        setPayload(p);
      })
      .catch((e) => {
        if (cancelled) return;
        setPayload({
          messages: [],
          warnings: [`initial fetch failed: ${(e as Error).message ?? String(e)}`],
        });
      });

    // SSE subscription — reconnects on close until cancelled.
    const baseUrl = getApiBaseSync();
    const token = getApiToken();
    const url = `${baseUrl}${api.autoCodeTranscriptStreamUrl(rowId, apiSession)}${
      token ? `&token=${encodeURIComponent(token)}` : ''
    }`;
    let es: EventSource | null = null;
    const open = () => {
      if (cancelled) return;
      try {
        es = new EventSource(url);
      } catch {
        setStatus('error');
        return;
      }
      es.addEventListener('transcript', (e) => {
        if (cancelled) return;
        try {
          const data = JSON.parse((e as MessageEvent).data) as AutoCodeTranscriptPayload;
          setPayload(data);
          setStatus('streaming');
        } catch {
          // Malformed event — keep the previous payload.
        }
      });
      es.addEventListener('error', () => {
        if (cancelled) return;
        setStatus('closed');
        es?.close();
        es = null;
        // Backoff before reconnect — don't hammer a downed server.
        setTimeout(() => {
          if (!cancelled) open();
        }, 2_000);
      });
    };
    open();

    return () => {
      cancelled = true;
      if (es) es.close();
    };
    // depKey covers session identity; session itself excluded
    // to avoid re-running on object-identity churn that doesn't
    // change the URL we'd hit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId, depKey]);
  return { payload, status };
}

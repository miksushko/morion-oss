import { useEffect, useRef, useState } from 'react';
import { getApiBaseSync, getApiToken } from '../lib/env';

/**
 * Subset of `GatherProgressEvent` from `src/core/concierge/context/
 * types.ts` shaped for UI consumption. Kept minimal to decouple from
 * backend type drift — if the backend adds a new event kind, the
 * `default` branch in `formatProgressLine` shows the raw kind so
 * nothing crashes.
 */
export type GatherProgressEvent =
  | { kind: 'cache_hit_exact'; cacheKey: string }
  | { kind: 'cache_hit_semantic'; similarity: number }
  | { kind: 'bootstrap_complete'; folderId: string | null; clusterCount: number }
  | { kind: 'wave_start'; wave: 1 | 2 | 3; subMoCount: number }
  | {
      kind: 'wave_complete';
      wave: 1 | 2 | 3;
      okCount: number;
      failedCount: number;
      spentUsd: number;
    }
  | { kind: 'synthesis_start' }
  | { kind: 'synthesis_complete'; spentUsd: number }
  | {
      kind: 'capped';
      reason: 'budget_exhausted' | 'body_read_cap' | 'wave_cap';
    };

export interface ToolProgressEnvelope {
  toolCallId: string;
  toolName: string;
  ts: number;
  event: GatherProgressEvent;
}

/**
 * Subscribe to the per-session SSE channel that streams Wave-by-Wave
 * progress events from long-running mo_* tool calls (today: only
 * `mo_get_context`'s gather pipeline).
 *
 * Lifecycle:
 *   - Opens an `EventSource` when `sessionId` + `enabled` are truthy.
 *   - Accumulates events into a state array; the consumer renders the
 *     latest as a status line under the inflight assistant bubble.
 *   - Closes + clears state when `enabled` flips to false (user's POST
 *     resolved → final message arrived → no more progress to expect).
 *   - Closes on unmount / sessionId change.
 *
 * The hook does NOT decide WHEN to enable; the consumer (chat panel)
 * gates on `busy` from the user-message POST + the absence of the
 * final assistant message. Real incident 2026-05-04: gather took
 * >60s with a static "Mo is thinking" indicator — this hook is the
 * fix that surfaces "Wave 1: 4/10 sub-Mos done → opening 8 candidate
 * notes → synthesising" as it happens.
 */
export function useToolProgress(
  sessionId: string | null | undefined,
  enabled: boolean,
): ToolProgressEnvelope[] {
  const [events, setEvents] = useState<ToolProgressEnvelope[]>([]);
  const evtRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!sessionId || !enabled) {
      // Disabled / no session — clear any prior buffered events so
      // the next dispatch starts visually fresh.
      setEvents([]);
      if (evtRef.current) {
        evtRef.current.close();
        evtRef.current = null;
      }
      return;
    }

    // EventSource doesn't support custom headers — pass token via
    // query param. Mirror the import.ts SSE pattern.
    const token = getApiToken();
    const url = `${getApiBaseSync()}/api/concierge/sessions/${encodeURIComponent(sessionId)}/tool-progress${
      token ? `?token=${encodeURIComponent(token)}` : ''
    }`;
    const es = new EventSource(url);
    evtRef.current = es;
    setEvents([]);

    const handle = (e: MessageEvent): void => {
      try {
        const env = JSON.parse(e.data) as ToolProgressEnvelope;
        setEvents((prev) => [...prev, env]);
      } catch {
        // ignore unparseable payloads
      }
    };
    es.addEventListener('progress', handle);
    es.addEventListener('message', handle);

    es.onerror = () => {
      // Connection lost or server closed the stream. We don't try to
      // reconnect — the dispatch loop is finite (synthesis_complete
      // or capped is the natural terminal). The chat panel will hide
      // the progress UI when the final message arrives anyway.
    };

    return () => {
      es.close();
      evtRef.current = null;
    };
  }, [sessionId, enabled]);

  return events;
}

/**
 * Convert a structured progress event to a one-line human label for
 * the chat status row. Stays terse — UI shows the LATEST event, not
 * a scrolling history.
 *
 * Russian copy because the user-facing chat is bilingual; users
 * dogfooding this saw English "Mo is thinking" and asked for parity
 * with the rest of the Mo voice. If the user's locale changes we'll
 * thread it through; for now the rest of the chat-tier Mo's voice
 * is bilingual already (system prompts respect language match).
 */
export function formatProgressLine(env: ToolProgressEnvelope): string {
  const e = env.event;
  switch (e.kind) {
    case 'cache_hit_exact':
      return 'Found a cached answer for this exact question — returning it now.';
    case 'cache_hit_semantic':
      return `Found a cached answer for a similar question (${(e.similarity * 100).toFixed(0)}% match).`;
    case 'bootstrap_complete':
      return e.clusterCount > 0
        ? `Bootstrap done — ${e.clusterCount} cluster(s) to scan. Spinning up sub-agents…`
        : 'Bootstrap done — fanning out across the workspace…';
    case 'wave_start':
      return `Wave ${e.wave}: started ${e.subMoCount} sub-agent(s) in parallel…`;
    case 'wave_complete':
      return `Wave ${e.wave} done: ${e.okCount}/${e.okCount + e.failedCount} sub-agents returned${e.failedCount > 0 ? ` (${e.failedCount} failed)` : ''} — $${e.spentUsd.toFixed(4)} so far.`;
    case 'synthesis_start':
      return 'Synthesising the answer from sub-agent findings…';
    case 'synthesis_complete':
      return `Synthesis done — total $${e.spentUsd.toFixed(4)}.`;
    case 'capped':
      return `Mo hit a hard cap (${e.reason.replace(/_/g, ' ')}) — wrapping up with what was gathered.`;
    default: {
      // Forward-compat: backend may add a new event kind. Don't crash
      // — show the raw kind so the user sees SOMETHING instead of nothing.
      const kind = (e as { kind: string }).kind;
      return `Mo: ${kind}`;
    }
  }
}

import { fetchOrThrow } from '../http';
import type { AutoCodeTranscriptPayload } from '../types';

/**
 * Auto-Code transcript + session surfaces — paused-session deep link
 * for human_gate stages, per-run sessions listing (replaces hardcoded
 * fix/review tabs with a dynamic dropdown for workflow-shaped runs),
 * one-shot transcript fetch, and the SSE stream URL the drawer wraps
 * in EventSource.
 */
export const autocodeTranscriptApi = {
  /** Phase 5 — read the linked Ask Mo session id for a paused run.
   *  Returns null when the run is not in `paused_ask_user` state or
   *  the link isn't set (legacy run or race condition). The drawer's
   *  PausedAskUserCTA uses this to deep-link the user into the chat. */
  getAutoCodeRunPausedSession: async (
    runId: string,
  ): Promise<string | null> => {
    const res = await fetchOrThrow(
      `/api/auto-code/runs/${encodeURIComponent(runId)}/paused-session`,
    );
    const j = (await res.json()) as { sessionId: string | null };
    return j.sessionId ?? null;
  },
  /** Phase 5 follow-up — list every session this run produced so
   *  the drawer's `SessionSelector` can replace the hardcoded
   *  fix/review tabs with a dynamic dropdown. Workflow-shaped runs
   *  return one entry per stage row with a `session_id` (cli_agent
   *  + human_gate + future mo_stage); legacy `mo_agent_queue` rows
   *  return 1-2 entries labelled "Fix session" / "Review session"
   *  for back-compat. */
  getAutoCodeRunSessions: async (
    rowId: string,
  ): Promise<{
    sessions: Array<{
      rowId?: string;
      stageId: string;
      stageKind: string;
      agentName: string | null;
      sessionId: string;
      status: string;
      attempt: number;
      label: string;
      engine: 'legacy' | 'workflow';
    }>;
  }> => {
    const res = await fetchOrThrow(
      `/api/auto-code/queue/${encodeURIComponent(rowId)}/sessions`,
    );
    return (await res.json()) as {
      sessions: Array<{
        rowId?: string;
        stageId: string;
        stageKind: string;
        agentName: string | null;
        sessionId: string;
        status: string;
        attempt: number;
        label: string;
        engine: 'legacy' | 'workflow';
      }>;
    };
  },
  /** One-shot transcript fetch (no live updates). Uses for initial
   *  drawer paint + re-fetch when the SSE stream drops.
   *
   *  Phase 5 follow-up: `session` arg now accepts the legacy literals
   *  `'fix' | 'review'` (back-compat for mo_agent_queue rows) AND a
   *  workflow-shaped selector `{stageId, stageRowId?}` that points
   *  at any session in a workflow run. */
  getAutoCodeTranscript: async (
    rowId: string,
    session:
      | 'fix'
      | 'review'
      | { stageId: string; stageRowId?: string },
  ): Promise<AutoCodeTranscriptPayload> => {
    const qs = typeof session === 'string'
      ? `session=${session}`
      : `stageId=${encodeURIComponent(session.stageId)}${
          session.stageRowId ? `&stageRowId=${encodeURIComponent(session.stageRowId)}` : ''
        }`;
    const res = await fetchOrThrow(
      `/api/auto-code/queue/${encodeURIComponent(rowId)}/transcript?${qs}`,
    );
    return (await res.json()) as AutoCodeTranscriptPayload;
  },
  /** SSE URL for live transcript updates. Caller wraps in EventSource
   *  + handles reconnect. URL only — no fetch — so the caller controls
   *  the lifecycle. */
  autoCodeTranscriptStreamUrl(
    rowId: string,
    session: 'fix' | 'review' | { stageId: string; stageRowId?: string },
  ): string {
    const qs = typeof session === 'string'
      ? `session=${session}`
      : `stageId=${encodeURIComponent(session.stageId)}${
          session.stageRowId ? `&stageRowId=${encodeURIComponent(session.stageRowId)}` : ''
        }`;
    return `/api/auto-code/queue/${encodeURIComponent(rowId)}/transcript/stream?${qs}`;
  },
};

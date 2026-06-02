import { fetchOrThrow } from './http';
import type {
  ConciergeBudgetStatus,
  ConciergeFolderSettings,
  ConciergeMessage,
  ConciergeProviderStatus,
  ConciergeSession,
  ConciergeSessionSearchHit,
  PipelineModelValues,
  PipelineModelsState,
  QuickActionResult,
} from './types';

/**
 * Direction V — Mo Concierge: per-folder Mo settings, sessions/messages,
 * tool-approval gate, quick-actions, budget, provider config, Mo
 * personality, per-pipeline model overrides.
 */
export const conciergeApi = {
  getConciergeFolderSettings: async (folderId: string): Promise<ConciergeFolderSettings> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/settings`,
    );
    return (await res.json()) as ConciergeFolderSettings;
  },

  putConciergeFolderSettings: async (
    folderId: string,
    patch: Partial<Omit<ConciergeFolderSettings, 'folderId' | 'workflowDefault' | 'createdAt' | 'updatedAt' | 'lastTickAt' | 'lastCheckpointAt'>>,
  ): Promise<ConciergeFolderSettings> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/settings`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
    return (await res.json()) as ConciergeFolderSettings;
  },

  listConciergeSessions: async (opts?: { includeArchived?: boolean; limit?: number }): Promise<{ items: ConciergeSession[]; needsHumanCount: number }> => {
    const qs = new URLSearchParams();
    if (opts?.includeArchived) qs.set('includeArchived', '1');
    if (opts?.limit) qs.set('limit', String(opts.limit));
    const res = await fetchOrThrow(
      `/api/concierge/sessions${qs.size ? `?${qs}` : ''}`,
    );
    return (await res.json()) as { items: ConciergeSession[]; needsHumanCount: number };
  },

  createConciergeSession: async (opts: { title?: string; folderId?: string | null }): Promise<ConciergeSession> => {
    const res = await fetchOrThrow('/api/concierge/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    return (await res.json()) as ConciergeSession;
  },

  patchConciergeSession: async (
    id: string,
    patch: { title?: string; archived?: boolean; needsHuman?: boolean },
  ): Promise<ConciergeSession> => {
    const res = await fetchOrThrow(
      `/api/concierge/sessions/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
    return (await res.json()) as ConciergeSession;
  },

  deleteConciergeSession: async (id: string): Promise<{ ok: true }> => {
    const res = await fetchOrThrow(
      `/api/concierge/sessions/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return (await res.json()) as { ok: true };
  },

  searchConciergeSessions: async (
    q: string,
    opts?: { limit?: number; includeArchived?: boolean },
  ): Promise<{ items: ConciergeSessionSearchHit[]; query: string }> => {
    const params = new URLSearchParams({ q });
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.includeArchived) params.set('includeArchived', '1');
    const res = await fetchOrThrow(
      `/api/concierge/sessions/search?${params.toString()}`,
    );
    return (await res.json()) as {
      items: ConciergeSessionSearchHit[];
      query: string;
    };
  },

  listConciergeMessages: async (sessionId: string, limit = 500): Promise<{ items: ConciergeMessage[] }> => {
    const res = await fetchOrThrow(
      `/api/concierge/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
    );
    return (await res.json()) as { items: ConciergeMessage[] };
  },

  approveConciergeTool: async (
    sessionId: string,
    messageId: string,
    decision: 'approve' | 'deny',
    reason?: string,
  ): Promise<{
    assistant: ConciergeMessage;
    toolResults: ConciergeMessage[];
    budget: ConciergeBudgetStatus;
  }> => {
    const res = await fetchOrThrow(
      `/api/concierge/sessions/${encodeURIComponent(sessionId)}/tool-approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, decision, reason }),
      },
    );
    return (await res.json()) as {
      assistant: ConciergeMessage;
      toolResults: ConciergeMessage[];
      budget: ConciergeBudgetStatus;
    };
  },

  sendConciergeMessage: async (
    sessionId: string,
    content: string,
    opts?: { signal?: AbortSignal; repliedActionId?: string },
  ): Promise<{
    user: ConciergeMessage;
    assistant: ConciergeMessage;
    budget: ConciergeBudgetStatus;
  }> => {
    const body: Record<string, unknown> = { content };
    if (opts?.repliedActionId) body.repliedActionId = opts.repliedActionId;
    const res = await fetchOrThrow(
      `/api/concierge/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts?.signal,
      },
    );
    return (await res.json()) as {
      user: ConciergeMessage;
      assistant: ConciergeMessage;
      budget: ConciergeBudgetStatus;
    };
  },

  applyConciergeQuickAction: async (
    sessionId: string,
    messageId: string,
    actionId: string,
  ): Promise<QuickActionResult> => {
    const res = await fetchOrThrow(
      `/api/concierge/sessions/${encodeURIComponent(sessionId)}/quick-action`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, actionId }),
      },
    );
    return (await res.json()) as QuickActionResult;
  },

  getConciergeBudget: async (): Promise<ConciergeBudgetStatus> => {
    const res = await fetchOrThrow('/api/concierge/budget');
    return (await res.json()) as ConciergeBudgetStatus;
  },
  /** Update the Mo monthly cap. Limits-tab counterpart of
   *  `putAutoCodeBudget`. Returns the fresh status post-write.
   *  Ticket 01KRNCDK0Y16R8QS8YP2AGSPTF. */
  putConciergeBudget: async (
    monthlyCapUsd: number,
  ): Promise<ConciergeBudgetStatus> => {
    const res = await fetchOrThrow('/api/concierge/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyCapUsd }),
    });
    return (await res.json()) as ConciergeBudgetStatus;
  },

  getConciergeProvider: async (): Promise<ConciergeProviderStatus> => {
    const res = await fetchOrThrow('/api/concierge/provider');
    return (await res.json()) as ConciergeProviderStatus;
  },

  getMoPersonality: async (): Promise<{
    grumpyMode: boolean;
    checkingCornersMaster: boolean;
    scheduleMode: 'manual' | 'timer';
    scheduleMinutes: 1 | 5 | 15;
  }> => {
    const res = await fetchOrThrow('/api/concierge/mo');
    return (await res.json()) as {
      grumpyMode: boolean;
      checkingCornersMaster: boolean;
      scheduleMode: 'manual' | 'timer';
      scheduleMinutes: 1 | 5 | 15;
    };
  },

  putMoPersonality: async (patch: {
    grumpyMode?: boolean;
    checkingCornersMaster?: boolean;
    scheduleMode?: 'manual' | 'timer';
    scheduleMinutes?: 1 | 5 | 15;
  }): Promise<{
    grumpyMode: boolean;
    checkingCornersMaster: boolean;
    scheduleMode: 'manual' | 'timer';
    scheduleMinutes: 1 | 5 | 15;
  }> => {
    const res = await fetchOrThrow('/api/concierge/mo', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return (await res.json()) as {
      grumpyMode: boolean;
      checkingCornersMaster: boolean;
      scheduleMode: 'manual' | 'timer';
      scheduleMinutes: 1 | 5 | 15;
    };
  },

  putConciergeProvider: async (patch: {
    backend?: ConciergeProviderStatus['backend'];
    apiKey?: string;
    model?: string;
  }): Promise<ConciergeProviderStatus> => {
    const res = await fetchOrThrow('/api/concierge/provider', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return (await res.json()) as ConciergeProviderStatus;
  },

  getConciergePipelineModels: async (): Promise<PipelineModelsState> => {
    const res = await fetchOrThrow('/api/concierge/pipeline-models');
    return (await res.json()) as PipelineModelsState;
  },

  putConciergePipelineModels: async (
    patch: Partial<PipelineModelValues>,
  ): Promise<PipelineModelsState> => {
    const res = await fetchOrThrow('/api/concierge/pipeline-models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return (await res.json()) as PipelineModelsState;
  },
};

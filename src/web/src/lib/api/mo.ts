import { fetchOrThrow } from './http';
import type {
  AcknowledgeFindingInput,
  AcknowledgeFindingResult,
  FolderCatalog,
  FolderLogs,
  FolderRisks,
  FolderTopic,
  RegenerateTopicResult,
  TopicCleanupRunResult,
  TopicCleanupStatus,
  TopicDocPayload,
} from './types';

/**
 * Mo Indexing per-folder surfaces: topics, project summary (catalog),
 * risks, logs (patrol findings), and finding acks. Every endpoint
 * lives under `/api/concierge/folders/:id/...` because Mo Indexing
 * is folder-scoped.
 */
export const moApi = {
  getFolderTopics: async (
    folderId: string,
  ): Promise<{ folderId: string; topics: FolderTopic[] }> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/topics`,
    );
    return (await res.json()) as { folderId: string; topics: FolderTopic[] };
  },

  regenerateFolderTopic: async (
    folderId: string,
    clusterId: string,
  ): Promise<RegenerateTopicResult> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/topics/${encodeURIComponent(clusterId)}/regenerate`,
      { method: 'POST' },
    );
    return (await res.json()) as RegenerateTopicResult;
  },

  createFolderTopic: async (
    folderId: string,
    name: string,
  ): Promise<{ folderId: string; clusterId: string; clusterNoteId: string }> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/topics`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    );
    return (await res.json()) as {
      folderId: string;
      clusterId: string;
      clusterNoteId: string;
    };
  },

  runTopicCleanup: async (folderId: string): Promise<TopicCleanupRunResult> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/topic-cleanup`,
      { method: 'POST' },
    );
    return (await res.json()) as TopicCleanupRunResult;
  },

  getTopicCleanupStatus: async (
    folderId: string,
  ): Promise<TopicCleanupStatus> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/topic-cleanup`,
    );
    return (await res.json()) as TopicCleanupStatus;
  },

  getFolderTopicDoc: async (
    folderId: string,
    clusterId: string,
  ): Promise<TopicDocPayload> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/topics/${encodeURIComponent(clusterId)}`,
    );
    return (await res.json()) as TopicDocPayload;
  },

  patchFolderTopicDoc: async (
    folderId: string,
    clusterId: string,
    sections: Partial<{
      overview: string;
      state: string;
      open: string;
      notes: string;
    }>,
  ): Promise<TopicDocPayload> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/topics/${encodeURIComponent(clusterId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections }),
      },
    );
    return (await res.json()) as TopicDocPayload;
  },

  getFolderRisks: async (folderId: string): Promise<FolderRisks> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/risks`,
    );
    return (await res.json()) as FolderRisks;
  },

  getFolderCatalog: async (folderId: string): Promise<FolderCatalog> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/catalog`,
    );
    return (await res.json()) as FolderCatalog;
  },

  patchFolderCatalog: async (
    folderId: string,
    sections: Partial<{
      overview: string;
      clusters: string;
      recent: string;
      risks: string;
    }>,
  ): Promise<FolderCatalog> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/catalog`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections }),
      },
    );
    return (await res.json()) as FolderCatalog;
  },

  getFolderLogs: async (folderId: string): Promise<FolderLogs> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/logs`,
    );
    return (await res.json()) as FolderLogs;
  },

  acknowledgeFinding: async (
    findingId: string,
    body: AcknowledgeFindingInput,
  ): Promise<AcknowledgeFindingResult> => {
    const res = await fetchOrThrow(
      `/api/concierge/findings/${encodeURIComponent(findingId)}/acknowledge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return (await res.json()) as AcknowledgeFindingResult;
  },
};

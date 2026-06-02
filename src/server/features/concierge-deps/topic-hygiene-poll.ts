/**
 * Topic-hygiene scheduler glue. Returns the poll function the
 * scheduler runs every interval; the function is a thin closure over
 * `pollTopicHygieneAcrossFolders` that pulls the Mo-enabled folder
 * list per call (so toggling Mo on/off mid-process takes effect on
 * the next scheduler check) and constructs the per-folder run deps
 * lazily so we don't keep stale providers alive.
 */
import { resolveMoIndexingProvider } from './indexing-deps.js';
import type { ConciergeDepsHost } from './types.js';

/**
 * Build a topic-hygiene poll function for the scheduler. Returns null
 * when the host doesn't have the required indexing bag (test
 * harnesses that disable indexing). Production wiring always supplies
 * it.
 */
export function buildTopicHygienePoll(
  host: ConciergeDepsHost,
): (() => Promise<void>) | null {
  const clusters = host.concierge.moClusters;
  const clusterQueue = host.concierge.moClusterQueue;
  const decisions = host.concierge.moTopicDecisions;
  if (!clusters || !clusterQueue || !decisions) return null;

  return async () => {
    const { TOPIC_HYGIENE_LAST_RUN_AT, pollTopicHygieneAcrossFolders } =
      await import('../../../core/concierge/index.js');

    const enabled = host.concierge.folderSettings.listEnabled();
    const enabledFolderIds = enabled.map((s) => s.folderId);

    await pollTopicHygieneAcrossFolders({
      enabledFolderIds,
      getLastRunAt: (folderId) =>
        host.settings.get<number>(TOPIC_HYGIENE_LAST_RUN_AT(folderId), 0) || null,
      setLastRunAt: (folderId, ts) =>
        host.settings.set(TOPIC_HYGIENE_LAST_RUN_AT(folderId), ts),
      getTopicExclusions: (folderId) =>
        host.concierge.folderSettings.getOrDefault(folderId).topicExclusions ?? '',
      buildRunDeps: (folderId) => {
        const provider = resolveMoIndexingProvider(host);
        if (!provider) return null;
        void folderId;
        return {
          db: host.db,
          clusters,
          clusterQueue,
          decisions,
          sessions: host.concierge.sessions,
          messages: host.concierge.messages,
          provider: provider.provider,
          budget: host.concierge.budget,
          model: provider.topicHygieneModel,
          fallbackModel: provider.topicHygieneFallbackModel,
        };
      },
    });
  };
}

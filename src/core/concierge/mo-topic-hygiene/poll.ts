import type { RunTopicHygieneDeps } from './types.js';
import { runTopicHygiene } from './run.js';

/**
 * Periodic poll wrapper — runs `runTopicHygiene` for every Mo-enabled
 * folder whose last run is older than `intervalMs`. Sequential, not
 * parallel: one folder at a time so a budget-exhaust on folder A
 * cleanly skips folder B (instead of starting both in parallel and
 * burning the cap twice). Returns a summary of which folders were
 * touched, for scheduler logging.
 *
 * Caller (`ConciergeScheduler.poll()`) is expected to call this at
 * most once per `intervalMs` itself — the per-folder cooldown is
 * defence-in-depth against caller drift.
 */
export interface TopicHygienePollDeps {
  /** Folder ids to consider (typically Mo-enabled set). Empty = no-op. */
  enabledFolderIds: string[];
  /** Last-run lookup. Returns 0 / null if never ran. */
  getLastRunAt: (folderId: string) => number | null;
  /** Setter called after every successful (status='ok'|'skipped') run. */
  setLastRunAt: (folderId: string, ts: number) => void;
  /** Per-folder topic exclusions. Empty string is fine. */
  getTopicExclusions: (folderId: string) => string;
  /** Hygiene engine deps factory — called per folder so a fresh
   *  budget snapshot / provider is used per folder. Returns null when
   *  the gate (Pro / backend / key) isn't satisfied for that folder
   *  and the folder should be skipped. */
  buildRunDeps: (folderId: string) => RunTopicHygieneDeps | null;
  /** Default 4h. */
  intervalMs?: number;
  now?: () => number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface TopicHygienePollSummary {
  considered: number;
  ranOk: number;
  ranSkipped: number;
  errors: number;
  cooledDown: number;
  details: Array<{
    folderId: string;
    outcome: 'ok' | 'skipped' | 'error' | 'cooled_down' | 'gate_failed';
    reason?: string;
  }>;
}

const DEFAULT_TOPIC_HYGIENE_INTERVAL_MS = 4 * 60 * 60 * 1000;

export async function pollTopicHygieneAcrossFolders(
  deps: TopicHygienePollDeps,
): Promise<TopicHygienePollSummary> {
  const intervalMs = deps.intervalMs ?? DEFAULT_TOPIC_HYGIENE_INTERVAL_MS;
  const now = (deps.now ?? Date.now)();
  const summary: TopicHygienePollSummary = {
    considered: deps.enabledFolderIds.length,
    ranOk: 0,
    ranSkipped: 0,
    errors: 0,
    cooledDown: 0,
    details: [],
  };

  for (const folderId of deps.enabledFolderIds) {
    const lastRun = deps.getLastRunAt(folderId) ?? 0;
    if (lastRun && now - lastRun < intervalMs) {
      summary.cooledDown++;
      summary.details.push({ folderId, outcome: 'cooled_down' });
      continue;
    }
    const runDeps = deps.buildRunDeps(folderId);
    if (!runDeps) {
      summary.details.push({ folderId, outcome: 'gate_failed' });
      continue;
    }
    try {
      const result = await runTopicHygiene(runDeps, folderId, {
        now,
        topicExclusions: deps.getTopicExclusions(folderId),
      });
      deps.setLastRunAt(folderId, now);
      if (result.status === 'ok') {
        summary.ranOk++;
        summary.details.push({ folderId, outcome: 'ok' });
        deps.log?.info('topic hygiene ok', {
          folderId,
          autoMerged: result.autoMerged.length,
          escalated: result.escalatedToChat.length,
        });
      } else if (result.status === 'skipped') {
        summary.ranSkipped++;
        summary.details.push({ folderId, outcome: 'skipped', reason: result.reason });
      } else {
        summary.errors++;
        summary.details.push({ folderId, outcome: 'error', reason: result.message });
      }
    } catch (err) {
      summary.errors++;
      summary.details.push({
        folderId,
        outcome: 'error',
        reason: (err as Error).message,
      });
      deps.log?.warn('topic hygiene threw', {
        folderId,
        error: (err as Error).message,
      });
    }
  }

  return summary;
}

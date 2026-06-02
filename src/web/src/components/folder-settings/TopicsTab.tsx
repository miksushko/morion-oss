import { useEffect, useRef, useState } from 'react';
import {
  api,
  type ConciergeFolderSettings,
  type FolderTopic,
  type TopicCleanupRunResult,
  type TopicCleanupStatus,
} from '../../lib/api';
import { BlockedBanner, MoEnableBanner } from './banners';
import { TopicCleanupCard } from './topics/TopicCleanupCard';
import { TopicEditorPane } from './topics/TopicEditorPane';
import { TopicRail } from './topics/TopicRail';

/**
 * Indexed Topics tab (Phase 6.2 → 6.8 redesign).
 *
 * Master-detail surface inside the (wider) Folder Settings popup:
 *   - Left rail: scrollable list of topics, "+ New topic" affordance.
 *   - Right pane: editor for the selected topic's full doc body (the
 *     mo:cluster:<id> note's anchored sections), debounced autosave,
 *     "Refresh" button to force Tier 2 regen.
 *
 * Plus the topic cleanup engine (manual trigger + last-run indicator)
 * and the per-folder generic-terms blocklist for the Tier 1 prompt.
 *
 * Per the user's design spec: all topic content lives ONLY here.
 * Per-note panel doesn't describe topic prose — only assigns clusters
 * via dropdown / chips.
 */
export function TopicsTab({
  folderId,
  blockedReason,
  moEnabled,
  canEnableMo,
  savingMo,
  onToggleMo,
  conciergeSettings,
  onConciergeUpdated,
}: {
  folderId: string;
  blockedReason: string | null;
  moEnabled: boolean;
  canEnableMo: boolean;
  savingMo: boolean;
  onToggleMo: (next: boolean) => Promise<void>;
  conciergeSettings: ConciergeFolderSettings | null;
  onConciergeUpdated: (next: ConciergeFolderSettings) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [topics, setTopics] = useState<FolderTopic[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyClusterId, setBusyClusterId] = useState<string | null>(null);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(
    null,
  );
  const [newTopicDraft, setNewTopicDraft] = useState('');
  const [creatingTopic, setCreatingTopic] = useState(false);

  // Per-folder generic-terms blocklist for the Tier 1 prompt.
  // Hydrated once from conciergeSettings, then debounced-saved on edit
  // via PATCH. `exclusionsHydratedRef` follows the workflow-tab pattern
  // — without it, every PATCH response re-runs the effect and clobbers
  // in-flight edits.
  const [exclusionsDraft, setExclusionsDraft] = useState('');
  const [exclusionsSaving, setExclusionsSaving] = useState(false);
  const [exclusionsSavedAt, setExclusionsSavedAt] = useState<number | null>(null);
  const exclusionsHydratedRef = useRef(false);
  const exclusionsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Topic cleanup engine — manual trigger + last-run indicator.
  const [cleanupStatus, setCleanupStatus] = useState<TopicCleanupStatus | null>(null);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupLastResult, setCleanupLastResult] = useState<TopicCleanupRunResult | null>(null);

  const loadCleanupStatus = async () => {
    try {
      const status = await api.getTopicCleanupStatus(folderId);
      setCleanupStatus(status);
    } catch {
      // Silent — status is informational; the run button still works.
    }
  };

  useEffect(() => {
    void loadCleanupStatus();
    setCleanupLastResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  const onRunCleanup = async () => {
    setCleanupRunning(true);
    setError(null);
    try {
      const result = await api.runTopicCleanup(folderId);
      setCleanupLastResult(result);
      // Refresh both topic list (clusters may have merged away) and
      // the status row (lastRunAt + decisions).
      await Promise.all([load(), loadCleanupStatus()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCleanupRunning(false);
    }
  };

  useEffect(() => {
    if (conciergeSettings && !exclusionsHydratedRef.current) {
      setExclusionsDraft(conciergeSettings.topicExclusions ?? '');
      exclusionsHydratedRef.current = true;
    }
  }, [conciergeSettings]);

  // Reset hydration when the folder changes — different folder, fresh
  // exclusions value to load.
  useEffect(() => {
    exclusionsHydratedRef.current = false;
  }, [folderId]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getFolderTopics(folderId);
      setTopics(res.topics);
      // Auto-select the first topic on first load so the editor pane
      // isn't blank when the user opens the tab.
      if (res.topics.length > 0 && selectedClusterId === null) {
        setSelectedClusterId(res.topics[0]!.clusterId);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedClusterId(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  const tabBlocked = blockedReason !== null;

  const onRegenerate = async (clusterId: string) => {
    setBusyClusterId(clusterId);
    setError(null);
    try {
      const result = await api.regenerateFolderTopic(folderId, clusterId);
      if ('error' in result) {
        setError(result.message ?? result.error);
      } else if (result.status === 'error') {
        setError(`${result.reason}: ${result.message}`);
      } else if (result.status === 'empty') {
        setError(
          result.reason === 'no_notes'
            ? 'Topic has no notes assigned — nothing to summarise.'
            : 'Notes lack Tier 1 summaries; Mo will retry on the next index tick.',
        );
      }
      if ('status' in result && result.status === 'computed') {
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyClusterId(null);
    }
  };

  const persistExclusions = async (value: string) => {
    setExclusionsSaving(true);
    setError(null);
    try {
      const updated = await api.putConciergeFolderSettings(folderId, {
        topicExclusions: value,
      });
      onConciergeUpdated(updated);
      setExclusionsSavedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExclusionsSaving(false);
    }
  };

  const onExclusionsChange = (value: string) => {
    setExclusionsDraft(value);
    if (exclusionsDebounceRef.current) {
      clearTimeout(exclusionsDebounceRef.current);
    }
    exclusionsDebounceRef.current = setTimeout(() => {
      void persistExclusions(value);
    }, 600);
  };

  useEffect(() => {
    return () => {
      if (exclusionsDebounceRef.current) {
        clearTimeout(exclusionsDebounceRef.current);
      }
    };
  }, []);

  const onCreateTopic = async () => {
    const raw = newTopicDraft.trim();
    if (!raw) return;
    setCreatingTopic(true);
    setError(null);
    try {
      const created = await api.createFolderTopic(folderId, raw);
      setNewTopicDraft('');
      await load();
      setSelectedClusterId(created.clusterId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreatingTopic(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header>
        <h2 className="text-base font-semibold">Indexed Topics</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Topics Mo discovered while indexing this folder — each one
          groups related notes under a theme and gets its own auto-
          maintained aggregator doc. Click a topic to read or edit its
          doc; use "+ New topic" to seed one yourself. Mo respects your
          edits on the next indexing pass.
        </p>
      </header>

      {tabBlocked && (
        <BlockedBanner
          reason={blockedReason!}
          hint="Re-enable MCP & Mo Access on Access Permissions to unlock."
        />
      )}
      {!tabBlocked && !moEnabled && (
        <MoEnableBanner
          moEnabled={moEnabled}
          canEnableMo={canEnableMo}
          savingMo={savingMo}
          onToggleMo={onToggleMo}
        />
      )}

      {!tabBlocked && moEnabled && (
        <TopicCleanupCard
          status={cleanupStatus}
          running={cleanupRunning}
          lastResult={cleanupLastResult}
          onRun={() => void onRunCleanup()}
        />
      )}

      <details className="group rounded-md border border-border bg-background/40 px-3 py-2 text-[12px]">
        <summary className="flex cursor-pointer items-center justify-between gap-2 text-muted-foreground hover:text-foreground">
          <span className="font-medium">Generic terms to avoid as topics</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
            {exclusionsSaving
              ? 'saving…'
              : exclusionsSavedAt
              ? 'saved'
              : exclusionsDraft.trim().length > 0
              ? `${exclusionsDraft.trim().length} chars`
              : 'empty'}
          </span>
        </summary>
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">
            Free-text list of words / short phrases the indexer should NOT use as topic ids in this folder. Use it for industry-generic vocabulary that doesn't help retrieval here. Example for a project-management tool: "task management, project management, agile, workflow management" (but keep "kanban" — that's a real product feature). The model still applies the workspace-wide rules (statuses, OS, environments, code layers, ticket types) on top.
          </p>
          <textarea
            value={exclusionsDraft}
            onChange={(e) => onExclusionsChange(e.target.value)}
            disabled={tabBlocked || !moEnabled}
            placeholder="task management, project management, agile, workflow management"
            rows={3}
            className="resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[12px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
          />
        </div>
      </details>

      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <TopicRail
          topics={topics}
          loading={loading}
          selectedClusterId={selectedClusterId}
          onSelect={setSelectedClusterId}
          newTopicDraft={newTopicDraft}
          onNewTopicChange={setNewTopicDraft}
          onCreate={() => void onCreateTopic()}
          creating={creatingTopic}
          disabled={tabBlocked || !moEnabled}
        />

        {/* Right pane: editor for the selected topic. */}
        <div className="flex min-h-0 flex-1 flex-col">
          {selectedClusterId ? (
            <TopicEditorPane
              key={selectedClusterId}
              folderId={folderId}
              clusterId={selectedClusterId}
              busy={busyClusterId === selectedClusterId}
              onRegenerate={() => void onRegenerate(selectedClusterId)}
              disabled={tabBlocked || !moEnabled}
            />
          ) : (
            <div className="flex h-full flex-1 items-center justify-center rounded-md border border-dashed border-border bg-background/20 p-6 text-xs italic text-muted-foreground">
              Select a topic on the left to edit its doc.
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

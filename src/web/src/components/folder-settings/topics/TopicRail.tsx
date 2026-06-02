import { Loader2, Plus } from 'lucide-react';
import { type FolderTopic } from '../../../lib/api';
import { cn } from '../../../lib/cn';

/** Left rail of the Indexed Topics tab — scrollable topic list with
 *  the "+ New topic" affordance. The right-pane editor lives on the
 *  parent TopicsTab so the rail stays stateless (props-only). */
export function TopicRail({
  topics,
  loading,
  selectedClusterId,
  onSelect,
  newTopicDraft,
  onNewTopicChange,
  onCreate,
  creating,
  disabled,
}: {
  topics: FolderTopic[];
  loading: boolean;
  selectedClusterId: string | null;
  onSelect: (clusterId: string) => void;
  newTopicDraft: string;
  onNewTopicChange: (next: string) => void;
  onCreate: () => void;
  creating: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex w-64 shrink-0 flex-col gap-2 overflow-hidden">
      <div className="flex items-center gap-1">
        <input
          value={newTopicDraft}
          onChange={(e) => onNewTopicChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onCreate();
            }
          }}
          placeholder="New topic name"
          disabled={creating || disabled}
          className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-[12px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
        />
        <button
          type="button"
          onClick={onCreate}
          disabled={creating || disabled || !newTopicDraft.trim()}
          title="Add a new topic with this name. Mo auto-generates a slug + description on the next indexing pass."
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-foreground hover:bg-accent disabled:opacity-50"
        >
          {creating ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Plus className="h-3 w-3" />
          )}
        </button>
      </div>

      {loading ? (
        <div className="flex-1 rounded-md border border-border bg-background/40 p-3 text-center text-xs text-muted-foreground">
          Loading topics…
        </div>
      ) : topics.length === 0 ? (
        <div className="flex-1 rounded-md border border-dashed border-border bg-background/20 p-3 text-center text-xs italic text-muted-foreground">
          No topics yet. Mo discovers them after the first indexing
          pass, or you can add one with the field above.
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto rounded-md border border-border bg-background/40 divide-y divide-border">
          {topics.map((topic) => {
            const active = selectedClusterId === topic.clusterId;
            return (
              <li key={topic.clusterId}>
                <button
                  type="button"
                  onClick={() => onSelect(topic.clusterId)}
                  className={cn(
                    'flex w-full flex-col items-start gap-1 px-2 py-2 text-left transition-colors',
                    active
                      ? 'bg-primary/15 text-foreground'
                      : 'hover:bg-accent/50',
                  )}
                >
                  <div className="flex flex-wrap items-baseline gap-1.5">
                    <span className="font-mono text-[12px] font-medium text-foreground">
                      {topic.clusterId}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {topic.noteCount}
                    </span>
                    {!topic.clusterNoteId && (
                      <span className="rounded bg-amber-500/15 px-1 py-0 text-[9px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                        New
                      </span>
                    )}
                  </div>
                  {topic.summary && (
                    <span className="line-clamp-2 text-[11px] text-muted-foreground">
                      {topic.summary}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

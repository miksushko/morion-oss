import type { CommentsSettings } from '../../lib/api';
import { SectionHeader } from './SectionHeader';
import { Toggle } from './Toggle';

// ---------- 2b. comments / activity gates (Direction Q) ----------

export function CommentsSection({
  comments,
  onPatch,
}: {
  comments: CommentsSettings;
  onPatch: (next: Partial<CommentsSettings>) => Promise<void>;
}) {
  return (
    <section>
      <SectionHeader
        title="Comments & activity"
        blurb="Per-note discussion threads — posted by you in the UI or by AI agents via MCP. Controls below gate what agents can do."
      />
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                Allow MCP to edit / delete its own comments
              </div>
              <div className="text-xs text-muted-foreground">
                When off, AI agents cannot modify their own comments — the kill-switch applies only to MCP actors. Your own UI posts stay editable regardless.
              </div>
            </div>
            <Toggle
              checked={comments.mcpCommentsEditable}
              onChange={(v) => onPatch({ mcpCommentsEditable: v })}
            />
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                Require LLM to explain every kanban status change
              </div>
              <div className="text-xs text-muted-foreground">
                When on, agents must include a `message` when moving a card between columns. Non-empty messages auto-post as comments in the card's activity feed. Your own drag-and-drop moves are unaffected.
              </div>
            </div>
            <Toggle
              checked={comments.requireLlmStatusComment}
              onChange={(v) => onPatch({ requireLlmStatusComment: v })}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

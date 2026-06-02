import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { renderCommentMarkdown } from '../../lib/renderMarkdown';
import type { DisplayItem } from './groupMessages';
import { truncateResult } from './truncate';

/**
 * Collapsible chip that hides a sequence of tool calls under one row
 * ("Used 3 tools: notes_search, mo_get_context, …"). Expands to show
 * each call's name(args) + truncated result. Sits inside the
 * conversation `<ul>`, so it renders as a `<li>`.
 */
export function ToolGroupChip({
  group,
}: {
  group: Extract<DisplayItem, { kind: 'tool-group' }>;
}) {
  const [open, setOpen] = useState(false);
  const count = group.calls.length;
  return (
    <li className="w-full">
      <div className="min-w-0 flex-1">
        {group.preface && (
          <div
            className="mo-chat-prose mb-2 text-sm leading-relaxed text-foreground"
            dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(group.preface) }}
          />
        )}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          Used {count} tool{count === 1 ? '' : 's'}
          {count <= 2 && (
            <span className="ml-1 font-mono text-muted-foreground/70">
              {group.calls.map((c) => c.name).join(', ')}
            </span>
          )}
        </button>
        {open && (
          <div className="mt-2 space-y-2">
            {group.calls.map((c) => (
              <div
                key={c.id}
                className="rounded-md border border-border bg-card/50 px-3 py-2 text-[11px]"
              >
                <div className="mb-1 font-mono text-foreground">
                  {c.name}({c.args})
                </div>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted-foreground">
                  {truncateResult(c.result)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

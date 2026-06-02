import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Edit3, MessageSquarePlus, MoreHorizontal, Trash2, User } from 'lucide-react';
import type { ActivityRow as ActivityRowData } from '../lib/api';
import { formatActor } from '../lib/formatActor';
import { formatRelativeTime } from '../lib/formatRelativeTime';
import { renderCommentMarkdown } from '../lib/renderMarkdown';
import { useResolveMorionImages } from '../lib/useResolveMorionImages';
import { cn } from '../lib/cn';

/**
 * Render a single row in the activity feed.
 *
 * Two variants discriminated by `row.kind`:
 *   - `event` → single-line compact: actor + verb + time. Muted.
 *   - `comment` → expanded card: actor + time + rendered markdown
 *     + optional reply/edit/delete actions. Inline edit textarea.
 *
 * Actions are gated client-side on actor-match: only the author of a
 * comment sees Edit / Delete. Server is authoritative (returns 403 if
 * the client forgets), but hiding them from the UI keeps the panel
 * clean for non-owners.
 *
 * `isReply` shifts the card 16px to the right + smaller gutter so
 * replies read as a thread under their parent.
 */
/**
 * Collapsed-state height budget in pixels. 9rem ≈ 144px at the default
 * 16px root, which maps to ~6 rows of the 1.5rem line-height inside
 * `.morion-comment-body` — the target from the ticket ("only first 5-6
 * rows, then Show more"). Matches the `max-h-36` Tailwind class used on
 * the body wrapper; keep both in sync if this is ever tuned.
 */
const COLLAPSED_PX = 144;

interface ActivityRowProps {
  row: ActivityRowData;
  /** Actor string of the current user/session — drives Edit/Delete visibility. */
  currentActor: string;
  /** Whether this card is a reply nested under a top-level parent. */
  isReply?: boolean;
  /** Whether the user can open a reply composer below this comment. Only
   *  meaningful on top-level comments (you can't reply to a reply). */
  canReply?: boolean;
  onEdit?: (commentId: string, newBody: string) => Promise<void> | void;
  onDelete?: (commentId: string) => Promise<void> | void;
  onReply?: (parentId: string) => void;
}

export function ActivityRow({
  row,
  currentActor,
  isReply,
  canReply,
  onEdit,
  onDelete,
  onReply,
}: ActivityRowProps) {
  if (row.kind === 'event') {
    return <EventRow row={row} />;
  }
  return (
    <CommentRow
      row={row}
      currentActor={currentActor}
      isReply={isReply}
      canReply={canReply}
      onEdit={onEdit}
      onDelete={onDelete}
      onReply={onReply}
    />
  );
}

// -------------------------------------------------------------
// Event variant — muted, single-line
// -------------------------------------------------------------

function EventRow({
  row,
}: {
  row: Extract<ActivityRowData, { kind: 'event' }>;
}) {
  const who = formatActor(row.actor);
  const when = formatRelativeTime(row.ts);

  // Per-action colour so the feed doesn't flatten into a grey stripe.
  // Each colour is a tailwind `text-<tone>-500 dark:text-<tone>-400`
  // paired with a matching `bg-<tone>-500/10` chip so the icon reads
  // as a coloured dot even on dense rows.
  let verb = '';
  let icon: React.ReactNode = null;
  let tone = 'muted';
  switch (row.action) {
    case 'create':
      verb = 'created the note';
      icon = <MessageSquarePlus className="h-3 w-3" />;
      tone = 'emerald'; // new thing in the world
      break;
    case 'update':
      verb = 'updated the note';
      icon = <Edit3 className="h-3 w-3" />;
      tone = 'sky'; // edit / in-progress work
      break;
    case 'delete':
      verb = 'moved the note to trash';
      icon = <Trash2 className="h-3 w-3" />;
      tone = 'rose'; // destructive
      break;
    case 'comment_delete':
      verb = 'deleted a comment';
      icon = <Trash2 className="h-3 w-3" />;
      tone = 'rose';
      break;
    case 'status_change':
      // Short form — coloured arrow icon already signals "status change",
      // no need for a verbose verb that then gets truncated and hides
      // the target column on narrow panels.
      verb = `${row.statusFrom ?? '?'} → ${row.statusTo ?? '?'}`;
      icon = <ArrowLeftRight className="h-3 w-3" />;
      tone = 'amber'; // transition
      break;
    default:
      verb = row.action;
  }

  // Precomputed class variants so Tailwind JIT picks them up. Dynamic
  // class concat like `text-${tone}-500` gets purged — the static
  // switch keeps all five variants in the build output.
  const toneClasses: Record<string, string> = {
    emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    sky: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    rose: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
    muted: 'bg-muted text-muted-foreground',
  };

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
      <span
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
          toneClasses[tone] ?? toneClasses.muted,
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground/70">{who}</span> {verb}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground/70">{when}</span>
    </div>
  );
}

// -------------------------------------------------------------
// Comment variant — card with markdown body + actions
// -------------------------------------------------------------

function CommentRow({
  row,
  currentActor,
  isReply,
  canReply,
  onEdit,
  onDelete,
  onReply,
}: {
  row: Extract<ActivityRowData, { kind: 'comment' }>;
  currentActor: string;
  isReply?: boolean;
  canReply?: boolean;
  onEdit?: (commentId: string, newBody: string) => Promise<void> | void;
  onDelete?: (commentId: string) => Promise<void> | void;
  onReply?: (parentId: string) => void;
}) {
  const isOwn = row.actor === currentActor;
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(row.body);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Long-comment collapsing (ticket 01KPGWRYCR8156B4YMSPAJHCC0).
  // `canCollapse` flips to true once the rendered body overflows the
  // COLLAPSED_PX budget (~6 rows at default comment line-height). The
  // user can then click "Show more" to expand. `expanded` stays
  // client-side — no server round-trip, no persistence. Reset on body
  // change (edit commits a new row.body prop).
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);

  useResolveMorionImages(bodyRef, [row.body]);

  useEffect(() => {
    // Reset expand state whenever a new body comes in (edit commit).
    setExpanded(false);
  }, [row.body]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // Measure actual rendered height against the collapsed cap. Use
    // scrollHeight so the check holds even while `max-height` is
    // clamping the visible size. ResizeObserver catches font-load,
    // image-load (via useResolveMorionImages swap), and window-resize
    // so we never show a stale button.
    const check = () => {
      setCanCollapse(el.scrollHeight > COLLAPSED_PX + 4);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [row.body]);

  const startEdit = () => {
    setDraftBody(row.body);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraftBody(row.body);
  };

  const commitEdit = async () => {
    if (!onEdit) return;
    const trimmed = draftBody.trim();
    if (!trimmed || trimmed === row.body) {
      cancelEdit();
      return;
    }
    setSaving(true);
    try {
      await onEdit(row.id, trimmed);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={cn(
        'group relative flex gap-2 rounded-md border border-border/60 bg-card px-3 py-2',
        isReply && 'ml-6 border-l-2 border-l-border',
      )}
    >
      <CommentAvatar actor={row.actor} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-semibold text-foreground">
            {formatActor(row.actor)}
          </span>
          <span className="shrink-0 text-muted-foreground/70 tabular-nums">
            · {formatRelativeTime(row.createdAt)}
          </span>
          {row.updatedAt != null && (
            <span className="shrink-0 text-muted-foreground/50" title={`Edited ${formatRelativeTime(row.updatedAt)}`}>
              (edited)
            </span>
          )}
        </div>
        {isOwn && !editing && (
          <CommentActions
            commentId={row.id}
            canReply={canReply && !isReply}
            onEdit={onEdit ? startEdit : undefined}
            onDelete={onDelete}
            onReply={onReply}
          />
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-1">
          <textarea
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void commitEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
              }
            }}
            className="min-h-[60px] w-full rounded-sm border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2 text-xs">
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded-sm px-2 py-0.5 text-muted-foreground hover:bg-accent"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void commitEdit()}
              className="rounded-sm bg-primary px-2 py-0.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={saving || !draftBody.trim()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div className="relative">
          <div
            ref={bodyRef}
            className={cn(
              'morion-comment-body text-sm text-foreground',
              canCollapse && !expanded && 'max-h-36 overflow-hidden',
            )}
            dangerouslySetInnerHTML={{ __html: renderCommentMarkdown(row.body) }}
          />
          {canCollapse && !expanded && (
            <div
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute inset-x-0 bottom-0 h-10',
                'bg-gradient-to-t from-card to-transparent',
                isReply && 'from-card/95',
              )}
            />
          )}
          {canCollapse && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="mt-1 text-xs font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      {!isOwn && canReply && !isReply && onReply && !editing && (
        <button
          type="button"
          onClick={() => onReply(row.id)}
          className="self-start text-xs text-muted-foreground hover:text-foreground"
        >
          Reply
        </button>
      )}
      </div>
    </div>
  );
}

/**
 * Avatar for a comment author. Two shapes:
 *   - `user` → neutral muted circle with a lucide `User` icon. Reads as
 *              "this is a human post".
 *   - `mcp:*` → primary-tinted circle with literal "AI" text. Reads as
 *              "this is an agent post". LLM clients collapse into one
 *              AI badge regardless of which tool (Claude, Cursor, …) —
 *              the full client name still appears in the header row
 *              next to the timestamp.
 *
 * Fallback for unknown actor strings uses the user shape so a future
 * third kind doesn't render as broken chrome.
 */
function CommentAvatar({ actor }: { actor: string }) {
  if (actor.startsWith('mcp:')) {
    return (
      <span
        className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
        aria-hidden="true"
        title="Posted by an AI agent via MCP"
      >
        AI
      </span>
    );
  }
  return (
    <span
      className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
      aria-hidden="true"
      title="Posted by you"
    >
      <User className="h-3 w-3" />
    </span>
  );
}

// -------------------------------------------------------------
// Inline action menu on own comments
// -------------------------------------------------------------

function CommentActions({
  commentId,
  canReply,
  onEdit,
  onDelete,
  onReply,
}: {
  commentId: string;
  canReply?: boolean;
  onEdit?: () => void;
  onDelete?: (commentId: string) => Promise<void> | void;
  onReply?: (parentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative shrink-0 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
      <button
        type="button"
        aria-label="Comment actions"
        className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-10 mt-1 min-w-[7rem] rounded-md border border-border bg-card py-1 text-sm shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {canReply && onReply && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onReply(commentId);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
            >
              Reply
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
            >
              Edit
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void onDelete(commentId);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-destructive hover:bg-destructive/10"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

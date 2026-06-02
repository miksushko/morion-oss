import {
  ChevronLeft,
  Share2,
  Copy as CopyIcon,
  RotateCcw,
  Trash,
  History,
  Archive,
} from 'lucide-react';
import type { Note, NoteRevision, Tag, Folder } from '../lib/api';
import type { SaveState } from '../appShellTypes';
import { TiptapEditor } from '../editor/TiptapEditor';
import { exportNoteAsMarkdown } from '../lib/exportNote';
import { RevisionsPopover } from '../components/RevisionsPopover';
import { cn } from '../lib/cn';
import { SaveStateIndicator } from './editor-pane/SaveStateIndicator';
import { EditorTagBar } from './editor-pane/EditorTagBar';
import { NoteActionsMenu } from './editor-pane/NoteActionsMenu';
import { useEditorPaneState } from './editor-pane/useEditorPaneState';

interface Props {
  note: Note | null;
  /** Full tag catalogue, used to render colored chips and the picker. */
  allTags: Tag[];
  /** All folders, for the "Move to..." picker inside the more menu. */
  folders: Folder[];
  onChange: (patch: { body?: string }) => void;
  onDelete: () => void;
  /** Archive the current note — parent calls api.archiveNote + toast.
   * Optional so trash mode / new-note preview can omit. */
  onArchive?: () => Promise<void> | void;
  onUnarchive?: () => Promise<void> | void;
  onUpdateTags: (nextTags: string[]) => void;
  onCreateTag: (name: string, color: string | null) => Promise<Tag>;
  /** Copy a structured payload (note body + MCP tool hints) to the clipboard. */
  onShareWithLLM: () => Promise<void> | void;
  /** Copy just the body markdown to the clipboard. */
  onCopyBody: () => Promise<void> | void;
  /** Create a duplicate of the current note. */
  onDuplicate: () => Promise<void> | void;
  /** Move the current note into another folder, or unfile it (null). */
  onMoveToFolder: (folderId: string | null) => Promise<void> | void;
  /** Open per-note MCP access dialog (Pro) or upsell modal (Free). Optional
   * so the trash mode editor can leave it out. */
  onOpenAIAccess?: () => void;
  /** Mobile back button — pops the pane stack to the notes pane. Hidden on md+. */
  onMobileBack: () => void;
  /**
   * Restore a historical revision into the live note. Parent owns the API
   * call + the local-state refresh + the toast. Disabled in trashMode (the
   * popover is anchored to a label, not a button, when the note is trashed).
   */
  onRestoreRevision?: (revision: NoteRevision) => Promise<void> | void;
  /** Copy a historical revision body to the clipboard. */
  onCopyRevisionBody?: (revision: NoteRevision) => Promise<void> | void;
  /**
   * Bumps every time the parent applies an external rewrite to the current
   * note (e.g. a revision restore). Same-id mutations don't normally reset
   * EditorPane's local body state — that would clobber in-flight typing.
   * This counter is the explicit "external state replaced, please resync
   * from props" signal.
   */
  externalSyncToken?: number;
  /**
   * Per-note autosave state. Drives the small footer indicator next to
   * "Edited X" — `Saving…`, `Saved`, or a sticky `Save failed`. Defaults
   * to `idle` when omitted (the indicator hides) so callers that don't
   * care about save state can drop the prop.
   */
  saveState?: SaveState;
  /**
   * Read-only mode for the trash view. When true Tiptap becomes
   * read-only, the tag chip "+" / remove affordances disappear, and the
   * Share / Copy / More cluster in the header is replaced by a single
   * Restore button. Pair with `onRestore`.
   */
  trashMode?: boolean;
  /** Called when the user clicks the Restore button in trash mode. */
  onRestore?: () => Promise<void> | void;
  /**
   * Hard-delete the currently-open trashed note. Parent owns the confirm
   * prompt and the API call. Only meaningful in `trashMode`.
   */
  onDeleteForever?: () => Promise<void> | void;
  /**
   * Direction P (inline images). Callback for upload errors surfaced
   * by the Tiptap paste/drop handler — parent wires this to the global
   * toast so the user sees "Upload failed: too large" etc.
   */
  onImageUploadError?: (message: string) => void;
  /**
   * Direction Q (activity panel). Right-column slot rendered beside the
   * editor when the user has opened the activity feed via
   * `activityToggle`. Parent owns the collapsed/expanded state; when
   * the panel is collapsed the parent passes its rail variant here.
   */
  activityPanel?: React.ReactNode;
  /**
   * Direction Q — toggle button rendered in the header action cluster
   * (between "Copy" and the more-menu). Parent controls icon / count /
   * click. Optional; list-folder notes show it, trash mode hides it.
   */
  activityToggle?: React.ReactNode;
}

/**
 * Editor pane. Local state for body so typing feels instant. Every
 * keystroke calls `onChange` synchronously — the parent does an optimistic
 * merge into the notes list (derives the display title from the body in
 * real time) and debounces the actual server save. Save scheduling does
 * NOT live here.
 *
 * On note switch we reset local state from the new note.
 *
 * The header carries three tool affordances on the right:
 *   1. **Share with LLM** (most prominent, labeled) — copies a paste-into-LLM
 *      payload that includes the body inline plus morion MCP tool hints
 *      (`notes_get`, `notes_search`) so the model can pull fresh state.
 *   2. **Copy** — copies just the markdown body, no envelope.
 *   3. **More** (three-dot menu) — Duplicate / Move to... / Delete. The trash
 *      button is gone; destructive actions live behind the menu now.
 *
 * Tags live in a chip row under the header. Chips use catalogue colors with
 * auto WCAG-safe text. The "+" button opens a `TagPicker` popover for
 * search/toggle/create.
 */
export function EditorPane({
  note,
  allTags,
  folders,
  onChange,
  onDelete,
  onArchive,
  onUnarchive,
  onUpdateTags,
  onCreateTag,
  onShareWithLLM,
  onCopyBody,
  onDuplicate,
  onMoveToFolder,
  onOpenAIAccess,
  onMobileBack,
  trashMode = false,
  onRestore,
  onDeleteForever,
  onRestoreRevision,
  onCopyRevisionBody,
  externalSyncToken,
  saveState = 'idle',
  onImageUploadError,
  activityPanel,
  activityToggle,
}: Props) {
  // Autosave-adjacent state lives in a dedicated hook so the
  // ordering invariant (see useEditorPaneState JSDoc + CLAUDE.md
  // autosave rule) is documented in one place. Must run BEFORE any
  // Tiptap render that reads `body` — otherwise note-switch flashes
  // stale content for one frame.
  const {
    body,
    pickerOpen,
    setPickerOpen,
    historyOpen,
    setHistoryOpen,
    historyAnchor,
    setHistoryAnchor,
    tagsByName,
  } = useEditorPaneState({ note, externalSyncToken, allTags });

  if (!note) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3 md:hidden">
          <button
            type="button"
            onClick={onMobileBack}
            aria-label="Back to notes"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="text-sm text-muted-foreground">
            {trashMode
              ? 'Trash is empty. Notes you delete will appear here for 7 days.'
              : 'Select a note or create a new one.'}
          </div>
        </div>
      </div>
    );
  }

  const handleToggleTag = (tagName: string) => {
    const next = note.tags.includes(tagName)
      ? note.tags.filter((t) => t !== tagName)
      : [...note.tags, tagName];
    onUpdateTags(next);
  };

  const handleCreateTag = async (name: string, color: string | null): Promise<Tag> => {
    const created = await onCreateTag(name, color);
    if (!note.tags.includes(created.name)) {
      onUpdateTags([...note.tags, created.name]);
    }
    return created;
  };

  const handleRemoveTag = (tagName: string) => {
    onUpdateTags(note.tags.filter((t) => t !== tagName));
  };

  const handleShareClick = async () => {
    try {
      await onShareWithLLM();
    } catch (err) {
      console.error(err);
    }
  };

  const handleCopyClick = async () => {
    try {
      await onCopyBody();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 md:px-6">
        <button
          type="button"
          onClick={onMobileBack}
          aria-label="Back to notes"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        {note.archivedAt != null && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            title="Archived — hidden from lists + search + MCP"
            aria-label="This note is archived"
          >
            <Archive className="h-3 w-3" />
            Archived
          </span>
        )}

        <EditorTagBar
          tags={note.tags}
          tagsByName={tagsByName}
          trashMode={trashMode}
          onRemoveTag={handleRemoveTag}
          pickerOpen={pickerOpen}
          onTogglePicker={() => setPickerOpen((v) => !v)}
          onClosePicker={() => setPickerOpen(false)}
          allTags={allTags}
          onToggleTag={handleToggleTag}
          onCreateTag={handleCreateTag}
        />

        <div className="flex shrink-0 ml-auto items-center gap-1.5">
          {trashMode ? (
            <>
              <button
                type="button"
                onClick={() => {
                  if (onRestore) void onRestore();
                }}
                aria-label="Restore note"
                title="Restore this note from the trash"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-accent/40 px-2.5 text-xs font-medium text-foreground transition-all hover:border-ring hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Restore</span>
              </button>
              {onDeleteForever && (
                <button
                  type="button"
                  onClick={() => void onDeleteForever()}
                  aria-label="Delete forever"
                  title="Permanently delete this note"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-transparent px-2 text-xs text-muted-foreground transition-all hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
                >
                  <Trash className="h-3.5 w-3.5" />
                  <span>Delete forever</span>
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={handleShareClick}
                aria-label="Share with LLM"
                title="Copy a paste-into-LLM payload (body + MCP tool hints)"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-transparent px-2 text-xs text-muted-foreground transition-all hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
              >
                <Share2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Share with LLM</span>
              </button>
              <button
                type="button"
                onClick={handleCopyClick}
                aria-label="Copy note body"
                title="Copy just the markdown body"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-transparent px-2 text-xs text-muted-foreground transition-all hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
              >
                <CopyIcon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Copy</span>
              </button>
              {activityToggle}
              <NoteActionsMenu
                noteTitle={note.title}
                folders={folders}
                currentFolderId={note.folderId}
                isArchived={note.archivedAt != null}
                onDuplicate={onDuplicate}
                onMoveToFolder={onMoveToFolder}
                onOpenAIAccess={onOpenAIAccess}
                onArchive={onArchive}
                onUnarchive={onUnarchive}
                onDelete={onDelete}
                onExport={() =>
                  exportNoteAsMarkdown({ title: note.title, body: note.body })
                }
              />
            </>
          )}
        </div>
      </div>

      {/* `min-h-0` is load-bearing — without it the flex child defaults to
          `min-height: auto` which is its intrinsic content size, so a long
          body blows past the parent's bounded height. Coupled with
          `overflow-hidden` on this wrapper + `h-full` on TiptapEditor's
          inner `overflow-y-auto` we'd previously form a cyclic sizing
          dependency under the kanban card modal (dialog has its own
          maxHeight clamp rather than a flex-1 ancestor), and `h-full`
          resolved to content height instead of the wrapper height. So
          the wrapper OWNS the scroll; TiptapEditor's inner wrapper is
          just for padding + BubbleMenu positioning. Lesson 2026-04-16
          "Modal wrappers need flex context for EditorPane-style
          children" generalised. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <TiptapEditor
          value={body}
          editable={!trashMode}
          autoFocus={!body.trim()}
          noteId={note.id}
          onUploadError={onImageUploadError}
          onChange={(next) => {
            if (trashMode) return;
            onChange({ body: next });
          }}
        />
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-2 text-[11px] text-muted-foreground">
        {!trashMode && <SaveStateIndicator state={saveState} />}
        {trashMode && note.deletedAt ? (
          <span>Deleted {new Date(note.deletedAt).toLocaleString()}</span>
        ) : (
          <button
            ref={setHistoryAnchor}
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 -mr-1.5',
              'text-muted-foreground hover:bg-accent hover:text-foreground',
              historyOpen && 'bg-accent text-foreground',
            )}
            aria-label="Open version history"
          >
            <History className="h-3 w-3" />
            <span>Edited {new Date(note.updatedAt).toLocaleString()}</span>
          </button>
        )}
        {!trashMode && onRestoreRevision && onCopyRevisionBody && (
          <RevisionsPopover
            noteId={note.id}
            anchor={historyAnchor}
            open={historyOpen}
            onClose={() => setHistoryOpen(false)}
            onRestore={async (rev) => {
              await onRestoreRevision(rev);
              setHistoryOpen(false);
            }}
            onCopy={async (rev) => {
              await onCopyRevisionBody(rev);
            }}
          />
        )}
      </div>
      </div>
      {activityPanel}
    </div>
  );
}




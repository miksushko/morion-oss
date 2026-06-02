import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Selection } from '@tiptap/pm/state';
import {
  preserveAnchorsForEditor,
  restoreAnchorsFromEditor,
} from './anchor-preserve';
import { openExternalUrl } from '../lib/openExternalUrl';
import { buildEditorExtensions } from './TiptapEditor/extensions';
import { EditorContextMenu } from './TiptapEditor/EditorContextMenu';
import { EditorToolbar } from './TiptapEditor/EditorToolbar';

interface Props {
  /** Current note body as markdown — source of truth. */
  value: string;
  /** Fires on every edit with the serialized markdown. */
  onChange: (next: string) => void;
  autoFocus?: boolean;
  /**
   * When false, the editor renders the markdown but blocks all input. Used by
   * the trash view, where notes are read-only until restored. Defaults to true.
   */
  editable?: boolean;
  /** Current note id — required for image paste/drop uploads. Null
   * while no note is selected; paste is ignored in that state. */
  noteId?: string | null;
  /** Callback for upload errors (size cap, unsupported type, network).
   * Wired to the global toast in App.tsx. */
  onUploadError?: (message: string) => void;
}

/**
 * Tiptap-based editor with markdown round-trip. The DB stores markdown; the
 * editor parses it on load via `tiptap-markdown` and serializes it back via
 * `editor.storage.markdown.getMarkdown()` on every change. Markdown stays the
 * source of truth at every boundary (DB, MCP, HTTP); WYSIWYG is only the
 * rendering inside the editor.
 *
 * Mount-once pattern matches the old CodeMirror wrapper: props update via
 * `editor.commands.setContent` without destroying the instance, and an
 * `externalSyncRef` guard stops the resulting `onUpdate` from bouncing the
 * value back through `onChange` (which would bump `updatedAt` on plain note
 * selection).
 *
 * Supported formatting, per the product spec:
 *   - inline: bold, italic, strike, inline code, link (BubbleMenu on select)
 *   - blocks: headings h1-h3, bullet list, ordered list, task list, code block,
 *     blockquote
 *   - keyboard + markdown input rules from StarterKit cover `#`, `-`, `1.`,
 *     `` ``` ``, `>`, `---`, etc.
 *
 * Composition: extensions live in `./TiptapEditor/extensions.ts`, the
 * BubbleMenu in `./TiptapEditor/EditorToolbar.tsx`, the right-click
 * menu in `./TiptapEditor/EditorContextMenu.tsx`, and the small toggle
 * button in `./TiptapEditor/ToolbarButton.tsx`. This shell owns the
 * editor lifecycle (useEditor + value-sync effect + editable toggle +
 * wrapper-level context-menu handler).
 */
export function TiptapEditor({
  value,
  onChange,
  autoFocus,
  editable = true,
  noteId,
  onUploadError,
}: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Hold onUploadError in a ref so the MorionImage extension (captured
  // once at mount) always calls the freshest handler even if the parent
  // swaps it out.
  const onUploadErrorRef = useRef(onUploadError);
  onUploadErrorRef.current = onUploadError;
  // Same pattern for noteId — extension options are frozen at create
  // time; passing through a getter via the upload handler keeps paste
  // / drop working across note switches without remounting the editor.
  const noteIdRef = useRef<string | null>(noteId ?? null);
  noteIdRef.current = noteId ?? null;
  // True while we dispatch a setContent from the external value-sync effect
  // OR during the initial mount settle. Prevents the resulting onUpdate from
  // round-tripping back to the parent, which otherwise bumps updatedAt the
  // moment you click another note. We start `true` so the mount-time onUpdate
  // (markdown parse round-trip) is suppressed — only real user input should
  // fire onChange.
  const externalSyncRef = useRef(true);

  // Editor right-click context menu state. Anchor (x, y) is the click
  // position in viewport coordinates — same convention as Sidebar /
  // NotesList context menus. `null` = closed.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const editor = useEditor({
    extensions: buildEditorExtensions({
      getNoteId: () => noteIdRef.current,
      getOnUploadError: () => onUploadErrorRef.current,
    }),
    content: value === ''
      ? { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] }
      : value,
    autofocus: autoFocus ? 'start' : false,
    editable,
    editorProps: {
      attributes: {
        class: 'tiptap-prose h-full w-full outline-none',
      },
      handleDOMEvents: {
        // Click on a link inside the editor opens the URL in the system
        // browser. Matches Apple Notes behavior: plain click = open, editing
        // link text is done via selection + BubbleMenu's Link button (or
        // deleting the link and retyping). Holding Alt/Option preserves the
        // old "place cursor" behavior in case the user really needs to edit
        // in place. Read-only mode (trash) also opens on plain click.
        click(_view, event) {
          const target = event.target as HTMLElement | null;
          const anchor = target?.closest('a');
          if (!anchor) return false;
          const href = anchor.getAttribute('href');
          if (!href) return false;
          if (event.altKey) return false; // let ProseMirror place the cursor
          event.preventDefault();
          void openExternalUrl(href);
          return true;
        },
        // Right-click → custom editor context menu (Insert table, plus
        // table-aware row/column ops when the cursor is inside a table).
        // Shift+right-click escapes to the native browser menu (spell-
        // check / inspect element / etc.) per the standard "modifier =
        // bypass" pattern.
        //
        // Place the cursor at the click position BEFORE opening the menu
        // so `editor.isActive('table')` reflects where the user actually
        // clicked, not the previous selection. Otherwise right-clicking
        // an empty area outside any table would still show row/column
        // ops if the previous cursor was inside a table — and worse,
        // right-clicking inside a fresh table cell would still show
        // "Insert table" (creating a nested table = broken document)
        // because the selection hadn't moved into the cell yet.
        contextmenu(view, event) {
          if (event.shiftKey) return false;
          event.preventDefault();
          // Stop propagation so the wrapper-level onContextMenu (which
          // exists to catch clicks BELOW the editor's content area)
          // doesn't run and override the cursor position we're about
          // to set in the cell.
          event.stopPropagation();
          const pos = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          // Use Tiptap's high-level command so the selection commit
          // routes through the same path as a real click — view.dispatch
          // alone wasn't enough to make `editor.isActive('table')`
          // reflect the cell during the immediately-following menu
          // render. The `near()` resolves "click on a non-textable
          // boundary" (e.g. between cells) to the nearest text caret.
          if (pos) {
            const { state } = view;
            const $pos = state.doc.resolve(pos.pos);
            const target = Selection.near($pos);
            editor
              .chain()
              .focus()
              .setTextSelection({ from: target.from, to: target.to })
              .run();
          }
          setContextMenu({ x: event.clientX, y: event.clientY });
          return true;
        },
      },
    },
    onUpdate({ editor }) {
      if (externalSyncRef.current) return;
      const editorMd = editor.storage.markdown.getMarkdown() as string;
      // Phase 6.6: reverse the anchor preservation done before
      // setContent so the saved body keeps `<!-- mo:section-* -->`
      // markers intact for the backend parser.
      onChangeRef.current(restoreAnchorsFromEditor(editorMd));
    },
  });

  // External value sync. We compare against the serialized markdown so we
  // only re-parse when the content actually differs — saves an undo-stack
  // reset on every keystroke the parent emits back.
  useEffect(() => {
    if (!editor) return;
    const currentEditor = editor.storage.markdown.getMarkdown() as string;
    const current = restoreAnchorsFromEditor(currentEditor);
    if (current === value) {
      // Content already matches — just release the guard (covers mount when
      // the initial content === value so setContent never runs).
      queueMicrotask(() => { externalSyncRef.current = false; });
      return;
    }
    externalSyncRef.current = true;
    const isEmpty = value === '';
    // Phase 6.6: substitute `<!-- mo:section-* -->` HTML comments
    // with readable unicode-bracketed tokens so Tiptap-markdown
    // (configured `html: false`) doesn't escape or strip them.
    const preserved = isEmpty ? value : preserveAnchorsForEditor(value);
    const content = isEmpty
      ? { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] }
      : preserved;
    editor.commands.setContent(content, { emitUpdate: false });
    if (isEmpty && editable) {
      // New empty note: focus the H1 so the user can start typing immediately.
      requestAnimationFrame(() => editor.commands.focus('start'));
    } else {
      // Existing note: don't steal focus from the notes list. The user
      // clicked a row to preview the note, not to start editing. They'll
      // click inside the editor when they want to type.
      editor.commands.blur();
    }
    // Keep the guard up through the next microtask — Tiptap can fire
    // onUpdate asynchronously after setContent returns.
    queueMicrotask(() => { externalSyncRef.current = false; });
  }, [editor, value, editable]);

  // Toggle the editor's editable flag without remounting. Trash view flips
  // this to false so the user can read the markdown but can't edit it.
  useEffect(() => {
    if (!editor) return;
    if (editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  // Scroll is owned by the parent (EditorPane's `min-h-0 flex-1
  // overflow-y-auto` wrapper) so both the 3-pane and the kanban card
  // modal cases share one sizing contract. Previously this wrapper
  // had its own `h-full overflow-y-auto`; under the modal's max-height
  // clamp, `h-full` resolved to content height instead of the parent's
  // clientHeight and the inner scroller never activated. See the
  // comment on the wrapper in EditorPane.tsx.
  // Outer-wrapper contextmenu handler. Tiptap's own contextmenu only
  // fires when the right-click lands on a DOM node it owns — which
  // means an empty note (where the editor div is just a few lines
  // tall) doesn't catch clicks in the empty space below. We register
  // the same handler on the wrapper so the menu opens regardless of
  // where in the editor pane the user right-clicks; if the click was
  // inside the editor, ProseMirror's contextmenu has already run and
  // this is a no-op (pos === null branch) since prevented bubbling.
  const onWrapperContextMenu = (e: React.MouseEvent): void => {
    if (e.shiftKey || !editor || !editable) return;
    if (e.defaultPrevented) return; // already handled by ProseMirror handler
    e.preventDefault();
    // Place cursor at the document end so Insert Table inserts in a
    // sensible spot (we know we're outside the document content area).
    editor.chain().focus('end').run();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <div
      className="relative flex min-h-full w-full flex-col px-6 py-4"
      onContextMenu={onWrapperContextMenu}
    >
      {editor && <EditorToolbar editor={editor} />}
      <EditorContent editor={editor} className="min-h-[60vh] w-full flex-1" />
      {editor && contextMenu && (
        <EditorContextMenu
          editor={editor}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

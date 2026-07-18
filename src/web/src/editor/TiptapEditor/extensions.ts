import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extension-placeholder';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { Markdown } from 'tiptap-markdown';
import { MorionImage } from '../MorionImage';
import type { Extensions } from '@tiptap/react';

/**
 * True only for strings that are unambiguously a URL (explicit scheme) or a
 * bare email — the set of tokens we want the Link extension to autolink.
 * Everything else (bare `foo.md`, `docs/plan.md`, `word.tld`) stays plain
 * text. Exported for the regression test in `tests/editor-autolink.test.ts`.
 */
export function isExplicitUrlOrEmail(url: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || // http://, https://, ftp://, app://
    /^mailto:/i.test(url) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url) // bare email address
  );
}

interface BuildExtensionsOptions {
  /** Live getter for the current note id — passed to MorionImage so paste
   *  / drop uploads always target the active note even though the
   *  extension is configured once at mount. */
  getNoteId: () => string | null;
  /** Live getter for the upload-error callback — same rationale as
   *  getNoteId. */
  getOnUploadError: () => ((message: string) => void) | undefined;
}

/**
 * The full Tiptap extension list for the Morion editor. Extracted from
 * `../TiptapEditor.tsx` (2026-05-16, ticket `01KRQYTJYX3NWJW5E1S4V1FDZ9`)
 * so the shell can stay focused on lifecycle / state / JSX.
 *
 * Returns a fresh array every call — Tiptap freezes the instance at
 * mount, so callers should invoke this once inside useEditor's config.
 */
export function buildEditorExtensions(opts: BuildExtensionsOptions): Extensions {
  return [
    StarterKit.configure({
      // Headings capped at h3 — notebook, not a wiki.
      heading: { levels: [1, 2, 3] },
      // Link extension: autolink URLs as the user types, open-on-click
      // we handle manually via editorProps.handleDOMEvents.click in the
      // shell so we can route through our Tauri IPC (Tauri webview would
      // otherwise navigate itself when you tap an http link). openOnClick
      // stays false so Tiptap doesn't also call window.open in parallel.
      //
      // shouldAutoLink: only turn UNAMBIGUOUS URLs (explicit scheme) and
      // emails into links. linkifyjs' default fuzzy matcher treats any
      // `word.tld` token as a bare domain — and `.md` is a real ccTLD, so
      // filenames like `plan.md` / `todo.md` / `CLAUDE_Canonical.md`
      // (this is a developer's notebook, full of them) were being linkified
      // on both type and paste. That corrupted copy/paste: on copy the link
      // marks serialized to `[plan.md](http://plan.md)`, and splitting the
      // adjacent word forced stray markdown escapes (`CLAUDE_` → `CLAUDE\_`,
      // because the trailing `_` became a boundary underscore). Requiring an
      // explicit scheme keeps real links (`https://…`, `mailto:…`) working
      // while leaving bare filenames and paths as plain text. Governs
      // linkOnPaste too (extension-link passes shouldAutoLink to its paste
      // handler).
      link: {
        openOnClick: false,
        autolink: true,
        shouldAutoLink: isExplicitUrlOrEmail,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      },
    }),
    Placeholder.configure({ placeholder: 'Start writing…' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // Table support — markdown round-trip via tiptap-markdown's
    // built-in serializer + markdown-it's GFM table parser. Right-
    // click "Insert table" inserts a default 3x3 with a header row;
    // right-click inside a table surfaces row/column ops. Column
    // resize is enabled (drag the right edge of any header/cell);
    // row height isn't configurable because GFM markdown can't
    // store it — rows auto-grow with content (Apple Notes parity).
    //
    // HTMLAttributes IS NOT honored on the rendered `<table>` —
    // @tiptap/extension-table ships a NodeView (`TableView`) that
    // imperatively `document.createElement('table')` and never
    // reads `this.options.HTMLAttributes`. Audited in ticket
    // `01KQPTQGYYSYX61T0NABEY5TNE`: this is the broader Tiptap
    // contract — any node with a NodeView bypasses renderHTML for
    // editor display, so HTMLAttributes set via `.configure()` is
    // silently ignored. Style table cells / borders via the parent
    // selector `.tiptap-prose table` (see src/web/src/index.css).
    Table.configure({
      resizable: true,
      allowTableNodeSelection: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    Markdown.configure({
      html: false,
      tightLists: true,
      bulletListMarker: '-',
      // linkify OFF. This is markdown-it's fuzzy autolinker, a SECOND
      // linkifier independent of the Link extension's `shouldAutoLink`
      // (above). It fires whenever markdown TEXT is parsed — on paste (via
      // transformPastedText) and on note load — and turned bare filename
      // tokens like `Claude.md` / `Agents.md` into `[Claude.md](http://…)`
      // links (`.md` reads as a ccTLD). Explicit CommonMark links
      // (`[x](url)`, `<https://…>`) are core syntax and still parse; only
      // the fuzzy bare-token guessing is disabled.
      linkify: false,
      breaks: false,
      transformPastedText: true,
      transformCopiedText: true,
    }),
    // Direction P — inline image support. Extends tiptap-image's
    // Image node with a React node view that resolves `morion://`
    // URLs via auth'd blob fetch, plus paste/drop handlers that
    // upload the file and swap the placeholder node. Option getters
    // read through refs so note switches don't require a remount.
    MorionImage.configure({
      inline: true,
      allowBase64: false,
      getNoteId: opts.getNoteId,
      getOnUploadError: opts.getOnUploadError,
    }),
  ];
}

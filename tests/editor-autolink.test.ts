// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { DOMParser } from '@tiptap/pm/model';
import { isExplicitUrlOrEmail } from '../src/web/src/editor/TiptapEditor/extensions';

/**
 * Regression for "Copy/Paste of the
 * Markdown is incorrect". A developer notebook is full of bare filenames
 * (`plan.md`, `docs/todo.md`, `CLAUDE_Canonical.md`). Two independent
 * linkifiers were turning them into links (`.md` reads as a real ccTLD):
 *   - the Link extension's linkifyjs autolink (governed by shouldAutoLink)
 *   - markdown-it's fuzzy `linkify` inside the markdown parser (paste + load)
 * On copy those link marks serialized to `[plan.md](http://plan.md)` and the
 * split forced stray `\_` escapes (`CLAUDE_` -> `CLAUDE\_`). The fix disables
 * both fuzzy linkifiers; only explicit-scheme URLs and emails autolink.
 *
 * Mirrors the marks/nodes/markdown config from
 * `src/web/src/editor/TiptapEditor/extensions.ts` so it exercises the same
 * parser/serializer the UI uses. (MorionImage is omitted — its React NodeView
 * is a DOM concern and doesn't touch the link/linkify contract under test.)
 */
function makeEditor(): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          shouldAutoLink: isExplicitUrlOrEmail,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      Markdown.configure({
        html: false,
        tightLists: true,
        bulletListMarker: '-',
        linkify: false,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: '',
  });
}

/** Replays the transformPastedText path from tiptap-markdown's clipboard
 *  plugin: parse plaintext as inline markdown, drop it into the doc, then
 *  read back the markdown that a copy would place on the clipboard. */
function pasteThenCopy(text: string): { dom: string; markdown: string } {
  const editor = makeEditor();
  try {
    const html = editor.storage.markdown.parser.parse(text, { inline: true });
    const el = document.createElement('div');
    el.innerHTML = html;
    const slice = DOMParser.fromSchema(editor.schema).parseSlice(el, {
      preserveWhitespace: true,
    });
    editor.view.dispatch(editor.state.tr.replaceSelection(slice));
    return {
      dom: editor.view.dom.innerHTML,
      markdown: (editor.storage.markdown.getMarkdown() as string).trim(),
    };
  } finally {
    editor.destroy();
  }
}

describe('isExplicitUrlOrEmail', () => {
  it('accepts explicit-scheme URLs', () => {
    expect(isExplicitUrlOrEmail('https://anthropic.com')).toBe(true);
    expect(isExplicitUrlOrEmail('http://localhost:7778/x')).toBe(true);
    expect(isExplicitUrlOrEmail('ftp://host/file')).toBe(true);
    expect(isExplicitUrlOrEmail('mailto:a@b.com')).toBe(true);
  });

  it('accepts bare emails', () => {
    expect(isExplicitUrlOrEmail('user@example.com')).toBe(true);
  });

  it('rejects bare filenames and paths (the bug class)', () => {
    expect(isExplicitUrlOrEmail('plan.md')).toBe(false);
    expect(isExplicitUrlOrEmail('todo.md')).toBe(false);
    expect(isExplicitUrlOrEmail('CLAUDE_Canonical.md')).toBe(false);
    expect(isExplicitUrlOrEmail('docs/plan.md')).toBe(false);
    expect(isExplicitUrlOrEmail('Agents.md')).toBe(false);
  });

  it('rejects bare domains (no scheme) — predictable over clever', () => {
    expect(isExplicitUrlOrEmail('anthropic.com')).toBe(false);
    expect(isExplicitUrlOrEmail('www.google.com')).toBe(false);
  });
});

describe('paste does not linkify bare filenames', () => {
  it('keeps a sentence of .md filenames as plain text', () => {
    const src =
      'Прочитай CLAUDE_Canonical.md docs/plan.md, tasks/todo.md, docs/lessons.md. Просто Claude.md и Agents.md';
    const { dom, markdown } = pasteThenCopy(src);
    // No link nodes at all.
    expect(dom).not.toContain('<a ');
    // Copy output is verbatim — no fake links, no stray escapes.
    expect(markdown).toBe(src);
    expect(markdown).not.toContain('](http');
    expect(markdown).not.toContain('\\_');
  });

  it('still applies inline formatting without leaving literal markers', () => {
    const { dom, markdown } = pasteThenCopy('**bold** and _italic_ text');
    expect(dom).toContain('<strong>bold</strong>');
    expect(dom).toContain('<em>italic</em>');
    expect(markdown).toBe('**bold** and *italic* text');
  });

  // Note: autolinking a real URL/email on paste is done by the Link
  // extension's ProseMirror paste rule (gated by isExplicitUrlOrEmail),
  // which only fires on a genuine ClipboardEvent — not reachable through
  // this markdown-parser replay. That path is verified in the browser
  // (real `https://…` and `a@b.com` pastes become links); here we pin the
  // complementary invariant: the markdown parser itself (linkify:false)
  // must NOT fabricate links, so nothing bare is ever mislinked.
  it('markdown parser never fabricates links from bare tokens', () => {
    const { dom } = pasteThenCopy('See https://anthropic.com or plan.md or a@b.com');
    expect(dom).not.toContain('<a ');
  });

  it('preserves explicit CommonMark links', () => {
    const { markdown } = pasteThenCopy('[anthropic](https://anthropic.com)');
    expect(markdown).toBe('[anthropic](https://anthropic.com)');
  });
});

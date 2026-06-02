// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import { Image } from '@tiptap/extension-image';

/**
 * Proves the editor treats markdown as the source of truth: whatever we feed
 * in via `setContent` must come back out of `editor.storage.markdown.getMarkdown()`
 * unchanged (modulo cosmetic whitespace). If this ever drifts we'd silently
 * corrupt user notes on every edit.
 *
 * We mirror the extension list from `src/web/src/editor/TiptapEditor.tsx` so
 * the test actually exercises the same parser/serializer the UI uses.
 */
function makeEditor(doc: string): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({
        html: false,
        tightLists: true,
        bulletListMarker: '-',
        linkify: true,
        breaks: false,
      }),
      // Direction P — Image node. We use the stock @tiptap/extension-image
      // here rather than `MorionImage` because the React NodeView it
      // registers is a DOM concern; the parse + serialize contract is
      // inherited unchanged from the base class. If a future extension
      // of `MorionImage` changes the markdown serializer, re-target this
      // test at the real subclass.
      Image.configure({ inline: true, allowBase64: false }),
    ],
    content: doc,
  });
}

function roundtrip(md: string): string {
  const editor = makeEditor(md);
  try {
    return (editor.storage.markdown.getMarkdown() as string).trim();
  } finally {
    editor.destroy();
  }
}

describe('Tiptap markdown round-trip', () => {
  it('preserves plain paragraphs', () => {
    expect(roundtrip('hello world')).toBe('hello world');
  });

  it('preserves headings h1-h3', () => {
    expect(roundtrip('# Title')).toBe('# Title');
    expect(roundtrip('## Section')).toBe('## Section');
    expect(roundtrip('### Subsection')).toBe('### Subsection');
  });

  it('preserves inline marks', () => {
    expect(roundtrip('**bold** text')).toBe('**bold** text');
    expect(roundtrip('*italic* text')).toBe('*italic* text');
    expect(roundtrip('~~strike~~ text')).toBe('~~strike~~ text');
    expect(roundtrip('inline `code` here')).toBe('inline `code` here');
  });

  it('preserves bullet lists', () => {
    const md = '- one\n- two\n- three';
    expect(roundtrip(md)).toBe(md);
  });

  it('preserves ordered lists', () => {
    const md = '1. one\n2. two\n3. three';
    expect(roundtrip(md)).toBe(md);
  });

  it('preserves task lists with checked state', () => {
    const md = '- [ ] todo\n- [x] done';
    const out = roundtrip(md);
    // tiptap-markdown serializes task items and preserves checked state.
    expect(out).toContain('[ ] todo');
    expect(out).toContain('[x] done');
  });

  it('preserves fenced code blocks', () => {
    const md = '```js\nconst x = 1;\n```';
    expect(roundtrip(md)).toBe(md);
  });

  it('preserves links', () => {
    const md = '[anthropic](https://anthropic.com)';
    expect(roundtrip(md)).toBe(md);
  });

  it('empty input round-trips to empty', () => {
    expect(roundtrip('')).toBe('');
  });

  // Direction P — inline image support. The Image node preserves src
  // + alt on the way out. Preserves our `morion://attachment/<id>`
  // scheme verbatim (no encoding), which is the load-bearing property
  // — the NodeView then resolves the URL via auth'd blob fetch on
  // render.

  it('preserves a morion:// attachment image with alt text', () => {
    const md = '![quarterly chart](morion://attachment/01K8Z9ABCDEFGHJKMNPQRSTVWX)';
    expect(roundtrip(md)).toBe(md);
  });

  it('preserves an image inline inside a paragraph', () => {
    const md = 'Before ![x](morion://attachment/01K8Z9ABCDEFGHJKMNPQRSTVWX) after';
    expect(roundtrip(md)).toBe(md);
  });

  it('preserves an image with empty alt', () => {
    const md = '![](morion://attachment/01K8Z9ABCDEFGHJKMNPQRSTVWX)';
    expect(roundtrip(md)).toBe(md);
  });

  it('preserves an external https image alongside a morion attachment', () => {
    const md =
      '![logo](https://example.com/logo.png)\n\n![shot](morion://attachment/01K8Z9ABCDEFGHJKMNPQRSTVWX)';
    // tiptap-markdown may normalise paragraph spacing; the important
    // invariant is the two image references round-trip shape-wise.
    const out = roundtrip(md);
    expect(out).toContain('![logo](https://example.com/logo.png)');
    expect(out).toContain(
      '![shot](morion://attachment/01K8Z9ABCDEFGHJKMNPQRSTVWX)',
    );
  });
});

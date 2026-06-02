// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import { Image } from '@tiptap/extension-image';
import {
  preserveAnchorsForEditor,
  restoreAnchorsFromEditor,
} from '../src/web/src/editor/anchor-preserve';

/**
 * Phase 6.6 — proves Mo's `<!-- mo:section-start/end id="..." -->`
 * markers survive a full Tiptap editor roundtrip when wrapped via
 * `preserveAnchorsForEditor` + `restoreAnchorsFromEditor`.
 *
 * Without the wrappers tiptap-markdown (configured `html: false`)
 * either escapes the comments to `&lt;!-- ... --&gt;` or strips
 * them entirely (`html: true`), which breaks the backend parsers
 * (`parseCatalogDoc` / `parseClusterDoc`) that scan the body for
 * matching anchors. The wrappers substitute readable
 * unicode-bracketed tokens (`⟦mo:section-start:id⟧`) which Tiptap
 * passes through as plain text; the reverse substitution restores
 * the original HTML comments before the markdown is saved.
 */

function fullRoundtrip(md: string): string {
  const editor = new Editor({
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
      Image.configure({ inline: true, allowBase64: false }),
    ],
    content: preserveAnchorsForEditor(md),
  });
  try {
    const editorMd = editor.storage.markdown.getMarkdown() as string;
    return restoreAnchorsFromEditor(editorMd).trim();
  } finally {
    editor.destroy();
  }
}

describe('preserveAnchorsForEditor / restoreAnchorsFromEditor', () => {
  // U+27E6 / U+27E7 — keep these out of literal positions because
  // esbuild trips on them in template literals. Plain string concat
  // works fine.
  const OPEN = String.fromCharCode(0x27e6);
  const CLOSE = String.fromCharCode(0x27e7);

  it('substitutes start + end markers with bracketed tokens', () => {
    const md = '<!-- mo:section-start id="overview" -->\nbody\n<!-- mo:section-end id="overview" -->';
    const out = preserveAnchorsForEditor(md);
    expect(out).toBe(
      OPEN + 'mo:section-start:overview' + CLOSE +
        '\nbody\n' +
        OPEN + 'mo:section-end:overview' + CLOSE,
    );
  });

  it('reverses tokens back to HTML comments', () => {
    const tokens =
      OPEN + 'mo:section-start:risks' + CLOSE +
      '\n- p1: thing\n' +
      OPEN + 'mo:section-end:risks' + CLOSE;
    const out = restoreAnchorsFromEditor(tokens);
    expect(out).toBe(
      '<!-- mo:section-start id="risks" -->\n- p1: thing\n<!-- mo:section-end id="risks" -->',
    );
  });

  it('is idempotent on input that already has tokens (preserve)', () => {
    const tokens =
      OPEN + 'mo:section-start:overview' + CLOSE +
      '\nbody\n' +
      OPEN + 'mo:section-end:overview' + CLOSE;
    expect(preserveAnchorsForEditor(tokens)).toBe(tokens);
  });

  it('is idempotent on input without any markers (restore)', () => {
    const md = '# Just a normal note\n\nNo anchors here.';
    expect(restoreAnchorsFromEditor(md)).toBe(md);
  });

  it('preserves multiple distinct sections in one body', () => {
    const md =
      '<!-- mo:section-start id="overview" -->\nA.\n<!-- mo:section-end id="overview" -->\n\nfree prose\n\n<!-- mo:section-start id="risks" -->\nB.\n<!-- mo:section-end id="risks" -->';
    const preserved = preserveAnchorsForEditor(md);
    expect(preserved).toContain('⟦mo:section-start:overview⟧');
    expect(preserved).toContain('⟦mo:section-end:overview⟧');
    expect(preserved).toContain('⟦mo:section-start:risks⟧');
    expect(preserved).toContain('⟦mo:section-end:risks⟧');
    expect(restoreAnchorsFromEditor(preserved)).toBe(md);
  });

  it('survives a full Tiptap editor roundtrip with paragraph content', () => {
    const md =
      'before prose\n\n<!-- mo:section-start id="overview" -->\n\nMo body here.\n\n<!-- mo:section-end id="overview" -->\n\nafter prose';
    expect(fullRoundtrip(md)).toContain('<!-- mo:section-start id="overview" -->');
    expect(fullRoundtrip(md)).toContain('<!-- mo:section-end id="overview" -->');
    expect(fullRoundtrip(md)).toContain('Mo body here.');
    expect(fullRoundtrip(md)).toContain('before prose');
    expect(fullRoundtrip(md)).toContain('after prose');
  });

  it('roundtrip survives multiple sections + headings + lists', () => {
    const md =
      '# Title\n\n<!-- mo:section-start id="overview" -->\n\n## Overview\n\n- item one\n- item two\n\n<!-- mo:section-end id="overview" -->\n\nuser prose between\n\n<!-- mo:section-start id="risks" -->\n\nRisks list.\n\n<!-- mo:section-end id="risks" -->';
    const out = fullRoundtrip(md);
    // Both anchors preserved.
    expect(out).toContain('<!-- mo:section-start id="overview" -->');
    expect(out).toContain('<!-- mo:section-end id="overview" -->');
    expect(out).toContain('<!-- mo:section-start id="risks" -->');
    expect(out).toContain('<!-- mo:section-end id="risks" -->');
    // Inner content preserved.
    expect(out).toContain('## Overview');
    expect(out).toContain('item one');
    expect(out).toContain('Risks list.');
    expect(out).toContain('user prose between');
  });

  it('rejects malformed ids — only matches the documented charset', () => {
    // Regex is /[a-z][a-z0-9_-]*/ — uppercase / leading digit not allowed.
    const badUpper = '<!-- mo:section-start id="Overview" -->';
    const badDigit = '<!-- mo:section-start id="9live" -->';
    expect(preserveAnchorsForEditor(badUpper)).toBe(badUpper);
    expect(preserveAnchorsForEditor(badDigit)).toBe(badDigit);
  });

  it('preserves anchors with hyphens, underscores, digits in id', () => {
    const md = '<!-- mo:section-start id="kanban-ui_v2" -->\nx\n<!-- mo:section-end id="kanban-ui_v2" -->';
    expect(fullRoundtrip(md)).toContain('<!-- mo:section-start id="kanban-ui_v2" -->');
    expect(fullRoundtrip(md)).toContain('<!-- mo:section-end id="kanban-ui_v2" -->');
  });
});

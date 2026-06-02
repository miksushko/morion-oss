/** @vitest-environment happy-dom */
import { describe, it, expect } from 'vitest';
import { renderCommentMarkdown } from '../src/web/src/lib/renderMarkdown';

describe('renderCommentMarkdown', () => {
  it('renders basic markdown to HTML', () => {
    const html = renderCommentMarkdown('**bold** and _italic_');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('linkifies plain URLs and adds target=_blank + rel for external https', () => {
    const html = renderCommentMarkdown('see https://example.com for details');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('escapes <script> tags to plain text (no executable element)', () => {
    // markdown-it is configured html:false, so raw HTML gets escaped
    // to &lt;script&gt;... — the literal characters survive as visible
    // text (which is fine, user will see the word "alert(1)"), but
    // there's no executable <script> element in the DOM.
    const html = renderCommentMarkdown('<script>alert(1)</script>hello');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('</script>');
    expect(html).toContain('&lt;script'); // literal escaped form is fine
  });

  it('refuses to render javascript: URLs as clickable links', () => {
    // markdown-it's default URL validator rejects javascript: — the
    // [text](url) markdown stays as literal text, not an <a href>.
    const html = renderCommentMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toMatch(/<a[^>]+href="javascript:/i);
  });

  it('rewrites morion://attachment/<id> images to data-morion-id placeholders (no src leak)', () => {
    const html = renderCommentMarkdown('look: ![screenshot](morion://attachment/01K123)');
    expect(html).toContain('data-morion-id="01K123"');
    expect(html).toContain('alt="screenshot"');
    // No raw src attribute → browser can't fire an unauth'd GET to the morion:// URL.
    expect(html).not.toMatch(/<img[^>]+src="morion:/);
  });

  it('leaves external https image URLs alone (pass-through)', () => {
    const html = renderCommentMarkdown('![cat](https://example.com/cat.png)');
    expect(html).toContain('src="https://example.com/cat.png"');
  });

  it('does not emit <img src="javascript:..."> for sneaky schemes', () => {
    const html = renderCommentMarkdown('![x](javascript:alert(1))');
    // markdown-it's URL validator rejects javascript: for image srcs too.
    // The important invariant: no <img element with a js-executing src.
    expect(html).not.toMatch(/<img[^>]+src="javascript:/i);
  });

  it('preserves code fences and inline code', () => {
    const html = renderCommentMarkdown('inline `code` and\n\n```\nblock\n```');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<pre>');
    expect(html).toContain('block');
  });

  it('turns single newlines into <br> (breaks: true for chat UX)', () => {
    const html = renderCommentMarkdown('line one\nline two');
    expect(html).toContain('<br');
  });
});

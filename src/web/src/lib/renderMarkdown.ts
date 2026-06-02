import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

/**
 * Markdown → sanitized HTML pipeline for read-only comment bodies.
 *
 * Architecture:
 *   1. `markdown-it` parses markdown → HTML string.
 *   2. Custom `image` render rule rewrites `morion://attachment/<id>`
 *      into an `<img data-morion-id="<id>">` (no `src` yet — we don't
 *      want the browser to fire an unauth'd GET to that URL).
 *   3. `DOMPurify.sanitize` strips `<script>` / `<iframe>` / `javascript:` /
 *      event handlers — preserves `data-morion-id` (in `ADD_ATTR`).
 *   4. Consumer renders the HTML via `dangerouslySetInnerHTML`, then
 *      runs `resolveMorionImages(containerRef)` in a `useEffect` to
 *      swap each `data-morion-id` node's src to a blob URL (auth'd via
 *      `api.fetchAttachment(id)`). Same pattern as
 *      `MorionImageNodeView` in the editor, just without Tiptap.
 *
 * Why not react-markdown: adds ~60KB, introduces a second JSX renderer
 * pipeline, and its custom-component API is awkward for our "swap <img>
 * src via blob fetch" case. markdown-it is already in our dep tree
 * (tiptap-markdown depends on it) so this is a zero-new-transitive
 * addition.
 */

const md = new MarkdownIt({
  html: false, // no raw HTML passthrough — DOMPurify is belt-and-braces
  breaks: true, // single \n → <br>, matches chat-app mental model
  linkify: true, // plain URLs become clickable
  typographer: false, // no smart-quote substitution — we want markdown verbatim
});

// Override the default `image` render rule so `morion://attachment/<id>`
// srcs become `<img data-morion-id="<id>" alt="...">` (no src attr so the
// browser doesn't fire an unauth'd request). External URLs pass through
// verbatim with a `src` attr, relying on CSP `img-src https: data: blob:`.
const MORION_ATTACHMENT_PREFIX = 'morion://attachment/';

md.renderer.rules.image = (tokens, idx, _opts, _env, self) => {
  const token = tokens[idx]!;
  const srcIdx = token.attrIndex('src');
  const rawSrc = srcIdx >= 0 ? (token.attrs![srcIdx]![1] ?? '') : '';
  const alt = token.content ?? '';

  if (rawSrc.startsWith(MORION_ATTACHMENT_PREFIX)) {
    const id = rawSrc.slice(MORION_ATTACHMENT_PREFIX.length);
    // Output a placeholder <img>; resolver promotes to real blob URL after render.
    // `data-morion-id` survives DOMPurify because we allow-list it explicitly.
    // `alt` survives because it's in the default allow list.
    const safeAlt = md.utils.escapeHtml(alt);
    const safeId = md.utils.escapeHtml(id);
    return `<img data-morion-id="${safeId}" alt="${safeAlt}" class="morion-comment-image morion-comment-image--pending" />`;
  }

  // External image — use default renderer.
  return self.renderToken(tokens, idx, _opts);
};

// Ensure external link clicks don't hijack the webview — open in system
// browser via target + rel. (The Tauri shell's default window navigation
// is already blocked by our open_external_url IPC guard, but this is
// defence-in-depth for dev / browser mode.)
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const token = tokens[idx]!;
  const hrefIdx = token.attrIndex('href');
  const href = hrefIdx >= 0 ? (token.attrs![hrefIdx]![1] ?? '') : '';
  // Only add target=_blank for external http(s) links. Relative / anchor /
  // morion:// links stay in-app.
  if (/^https?:\/\//i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, opts, env, self);
};

/** Parse + sanitize a markdown comment body. Returns safe HTML. */
export function renderCommentMarkdown(body: string): string {
  const html = md.render(body);
  return DOMPurify.sanitize(html, {
    // Allow our custom attribute so the post-mount resolver can find
    // morion:// images. DOMPurify also keeps alt, title, target, rel,
    // and class by default — all we need.
    ADD_ATTR: ['data-morion-id', 'target', 'rel'],
    // `img` is in the default allow list but we want it regardless of
    // future DOMPurify default changes.
    ADD_TAGS: [],
  });
}

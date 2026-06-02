/**
 * Phase 6.6: preserve mo:section anchored markers across the Tiptap
 * markdown roundtrip.
 *
 * Tiptap-markdown is configured html=false (the safe default - no
 * raw HTML in or out). With html=false, HTML comments get escaped
 * to their entity form on serialize. With html=true, they get
 * stripped entirely. Either way, opening any Mo-maintained note
 * (mo:catalog, mo:cluster, mo:risks, mo:patrol-log) and saving any
 * unrelated edit corrupts the section anchors. The next backend
 * parser pass cannot find matching anchors and the regen drops
 * user prose.
 *
 * Workaround that does not change the Tiptap schema: substitute
 * the HTML comments with a unicode-bracketed token before
 * setContent, and reverse the substitution after getMarkdown.
 * The tokens ride through the editor as plain text - no escaping,
 * no stripping, no AST surprises.
 *
 * Token shape uses U+27E6 / U+27E7 (mathematical white square
 * brackets) as outer delimiters - distinct from anything that
 * appears in user prose or regular markdown, and human-readable
 * so the user can identify Mo zones in the editor at a glance. A
 * future Phase 6.6 v2 will replace this with a proper Tiptap Node
 * that renders as a styled inline pill; for now the raw token is
 * the visual treatment.
 *
 * Id charset matches the backend regex /[a-z][a-z0-9_-]*-/ from
 * mo-catalog-doc.ts and mo-cluster-doc.ts ANCHORED_SECTION_RE so a
 * token that survives roundtrip parses correctly when the backend
 * reads the saved body.
 */

// MATHEMATICAL LEFT/RIGHT WHITE SQUARE BRACKETS (U+27E6, U+27E7).
// Built via String.fromCharCode rather than embedded literals
// because esbuild (used by Vite + vitest) trips on these specific
// code points when they appear in source. Codepoint constructor
// sidesteps the issue cleanly.
const TOKEN_OPEN = String.fromCharCode(0x27e6);
const TOKEN_CLOSE = String.fromCharCode(0x27e7);

const HTML_COMMENT_RE =
  /<!--\s*mo:section-(start|end)\s+id="([a-z][a-z0-9_-]*)"\s*-->/g;

const TOKEN_RE = new RegExp(
  TOKEN_OPEN + 'mo:section-(start|end):([a-z][a-z0-9_-]*)' + TOKEN_CLOSE,
  'g',
);

/** Markdown to editor: substitute HTML comments with readable
 *  tokens so Tiptap-markdown ships them through unchanged.
 *  Idempotent on inputs that already carry tokens (no-op). */
export function preserveAnchorsForEditor(markdown: string): string {
  return markdown.replace(
    HTML_COMMENT_RE,
    (_match, kind: string, id: string) =>
      TOKEN_OPEN + 'mo:section-' + kind + ':' + id + TOKEN_CLOSE,
  );
}

/** Editor to markdown: reverse the substitution so the saved body
 *  matches the backend parser expectations. Idempotent on inputs
 *  that do not carry tokens (no-op). */
export function restoreAnchorsFromEditor(editorMarkdown: string): string {
  return editorMarkdown.replace(
    TOKEN_RE,
    (_match, kind: string, id: string) =>
      '<!-- mo:section-' + kind + ' id="' + id + '" -->',
  );
}

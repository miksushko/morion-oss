/**
 * Language inference for Monaco syntax highlighting in the conflict
 * resolver's side panes. Extracted from ConflictResolverModal.tsx
 * on 2026-05-16. Pinned by `tests/conflict-resolver-language.test.ts`.
 *
 * Unknown extensions fall back to `plaintext` — the resolver MUST
 * always render something, even if Monaco doesn't have a tokenizer
 * for the file's language. Mapping is intentionally small (~25
 * entries) — covers everything the auto-code pipeline writes; if a
 * user-managed project introduces a rare extension, the plain-text
 * fallback is still safe to merge.
 */

export const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  sh: 'shell',
  bash: 'shell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  sql: 'sql',
  xml: 'xml',
};

export function inferLanguage(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  const ext = path.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext] ?? 'plaintext';
}

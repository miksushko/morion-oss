/**
 * Regression: opening MCP Settings on the production macOS build
 * crashed the React tree with `ReferenceError: useMemo is not defined`
 * (and a second `ReferenceError: formatRelative is not defined`).
 *
 * Ticket `01KRWSM9HET3T3MQTMB7AXRDXY`. Root cause: the May 2026
 * SettingsPanel split (`b7530fe`) extracted `ConnectSection.tsx` +
 * `ClientsSection.tsx` from the parent module without carrying the
 * `useMemo` import OR the local `formatRelative` helper. The root
 * `tsconfig.json` excludes `src/web`, so `tsc` never type-checked
 * these files; Vite/esbuild only transpiles (it does not flag
 * undefined identifiers); the React dev-overlay masks the same crash
 * in dev. So the bug rode all the way to a shipped binary.
 *
 * Two complementary guards:
 *
 * 1. Static pass: every React hook called inside any tsx file under
 *    src/web/src must be either (a) imported by name from 'react', or
 *    (b) reached as `React.<hook>` after a default `React` import.
 * 2. Render pass: each section the MCP Server tab composes is rendered
 *    via react-dom/server with stub props. Any free identifier that's
 *    undefined throws during initial render. Catches missing imports,
 *    missing local helpers, and anything else the static pass can't
 *    see.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  ClientsSection,
  ConnectSection,
  McpSection,
  CategoriesSection,
  CommentsSection,
} from '../src/web/src/layout/SettingsPanel';

const WEB_ROOT = join(__dirname, '..', 'src', 'web', 'src');

const REACT_HOOKS = [
  'useState',
  'useEffect',
  'useLayoutEffect',
  'useCallback',
  'useMemo',
  'useRef',
  'useContext',
  'useReducer',
  'useImperativeHandle',
  'useDeferredValue',
  'useTransition',
  'useId',
  'useSyncExternalStore',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // Skip macOS Finder dupes (` 2.tsx` orphans documented in tasks/todo.md)
    if (/ 2(\.[^.]+)?$/.test(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function stripStringsAndComments(src: string): string {
  // Drop `// line` and `/* block */` comments + the contents of '...' / "..."
  // / `...` strings so we don't false-positive on hook names appearing in
  // copy or imports inside doc comments.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^'\\])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""');
}

function findCalledHooks(src: string): Set<string> {
  const stripped = stripStringsAndComments(src);
  const called = new Set<string>();
  for (const hook of REACT_HOOKS) {
    // Match hook usage as either a call `useFoo(` or a generic call
    // `useFoo<T>(` — the latter is what bit ConnectSection.tsx.
    const re = new RegExp(`(?:^|[^a-zA-Z0-9_$.])${hook}\\s*[<(]`, 'm');
    if (re.test(stripped)) called.add(hook);
  }
  return called;
}

function findImportedHooks(src: string): { named: Set<string>; defaultReact: boolean } {
  const named = new Set<string>();
  let defaultReact = false;

  const importBlockRe = /import\s+([\s\S]*?)\s+from\s+['"]react['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importBlockRe.exec(src)) !== null) {
    const clause = m[1];
    // default specifier: `React` or `React, { ... }`
    if (/^\s*React\b/.test(clause) || /^\s*[A-Za-z_$][\w$]*\s*,/.test(clause)) {
      defaultReact = true;
    }
    // named specifiers between { ... }
    const braced = /\{([^}]*)\}/.exec(clause);
    if (braced) {
      for (const tok of braced[1].split(',')) {
        const t = tok.trim().replace(/^type\s+/, '').replace(/\s+as\s+.*$/, '');
        if (t) named.add(t);
      }
    }
  }
  return { named, defaultReact };
}

describe('MCP Server tab sections render without ReferenceError (01KRWSM9HET3T3MQTMB7AXRDXY)', () => {
  // SSR doesn't fire useEffect, so the network calls these sections
  // make on mount don't matter — useMemo and any local helper called
  // during initial render still execute and throw if undefined.

  it('ClientsSection renders (catches missing useMemo + formatRelative)', () => {
    expect(() => {
      renderToString(createElement(ClientsSection, { audit: [], onRefresh: () => {} }));
    }).not.toThrow();
  });

  it('ClientsSection renders with rows (exercises formatRelative)', () => {
    expect(() => {
      renderToString(
        createElement(ClientsSection, {
          audit: [
            { id: 'a1', actor: 'mcp:claude-code', tool: 'notes_list', timestamp: Date.now() - 5_000 },
            { id: 'a2', actor: 'mcp:codex', tool: 'tasks_list', timestamp: Date.now() - 90_000 },
          ] as never,
          onRefresh: () => {},
        }),
      );
    }).not.toThrow();
  });

  it('ConnectSection renders with bundled runtime (exercises useMemo)', () => {
    expect(() => {
      renderToString(
        createElement(ConnectSection, {
          runtime: {
            isBundled: true,
            launcherPath: '/Applications/Morion.app/Contents/Resources/morion',
            cwd: '/tmp',
          } as never,
        }),
      );
    }).not.toThrow();
  });

  it('McpSection renders', () => {
    expect(() => {
      renderToString(
        createElement(McpSection, {
          mcp: {
            enabled: true,
            categories: { notes: 'rw', tasks: 'rw', folders: 'rw', tags: 'rw', search: 'r', concierge: 'r' },
          } as never,
          onPatch: async () => {},
        }),
      );
    }).not.toThrow();
  });

  it('CategoriesSection renders', () => {
    expect(() => {
      renderToString(
        createElement(CategoriesSection, {
          mcp: {
            enabled: true,
            categories: { notes: 'rw', tasks: 'rw', folders: 'rw', tags: 'rw', search: 'r', concierge: 'r' },
          } as never,
          tools: {} as never,
          onPatch: async () => {},
        }),
      );
    }).not.toThrow();
  });

  it('CommentsSection renders', () => {
    expect(() => {
      renderToString(
        createElement(CommentsSection, {
          comments: { allowMcpComments: true, requireStatusComment: false } as never,
          onPatch: async () => {},
        }),
      );
    }).not.toThrow();
  });
});

describe('web hook imports — every called hook is imported (01KRWSM9HET3T3MQTMB7AXRDXY)', () => {
  const files = walk(WEB_ROOT);

  it('finds tsx files to scan', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('every React hook called inside src/web tsx is also imported', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const called = findCalledHooks(src);
      if (called.size === 0) continue;
      const { named, defaultReact } = findImportedHooks(src);
      for (const hook of called) {
        if (named.has(hook)) continue;
        if (defaultReact) continue; // accessible as React.<hook>; assume call site is `React.<hook>(`
        offenders.push(`${file.slice(WEB_ROOT.length + 1)}: calls ${hook} without importing it`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

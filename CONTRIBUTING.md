# Contributing to Morion

Thanks for your interest. This is Morion Community, the open-source edition of
Morion: a local-first notebook and kanban board with an MCP server. It takes bug,
security and compatibility fixes; new features ship in Morion 2.0
(https://morion.ai).

## Dev setup

```bash
npm install
npm run dev        # Vite UI on :5173 + Node sidecar on :7778
```

Other entry points:

```bash
npm run mcp        # stdio MCP server (after `npm run build`)
npm test           # vitest
npm run typecheck  # tsc --noEmit (server + core)
npm run build      # tsc + vite
```

## Architecture (where things live)

- `src/core` — domain logic, SQLite, migrations, search, permissions. Owns all
  DB access. Depends on nothing above it.
- `src/server` — Hono HTTP API + MCP stdio server + tool handlers. Depends on
  `src/core`.
- `src/web` — React/Vite/Tailwind/Tiptap UI. Talks **only** to the HTTP API,
  never imports `src/core`/`src/server`.
- `src/cli` — the `morion` CLI (`init` / `serve` / `mcp` / `import` / `export`).

Notes store **markdown** bodies; the title is the first body line. The desktop
(Tauri) shell, signing, and release pipeline live in a separate repository and
are not part of this repo.

## Pull requests

- Keep changes surgical and focused — one purpose per PR.
- A bug fix should come with a regression test that fails before the fix.
- Run `npm test` and `npm run build` before opening the PR; CI runs both.
- No emojis in code, comments, or commit messages.

## Trademark

The code is Apache-2.0, but the **Morion / Mo names, logos, and the morion.ai
domain are reserved** — see [`TRADEMARK.md`](./TRADEMARK.md). Contributions are
accepted under the project's license; you retain copyright to your contribution.

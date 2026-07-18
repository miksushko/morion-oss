# Morion

**Your notebook. Your task board. An auto-code harness. All local, all in one.**

Morion is a local-first workspace that speaks MCP. You write notes by hand in a
real notes app and organize work on a kanban board — and any LLM agent (Claude
Code, Cursor, Codex, Cline, Zed, …) reads, searches, and writes the **same
SQLite file** right alongside you. Every AI edit is logged with the agent's name.

Your data lives on your disk, not in the cloud — no account, no per-token
memory tax. **Free and open source (Apache 2.0).**

> **This is the open-source core of Morion.** It runs locally in your browser.
> Official, code-signed **macOS / Windows desktop builds** are produced by the
> project owner at **https://morion.ai** — the desktop shell, code signing, and
> release pipeline live in a separate repo. See `TRADEMARK.md` before
> redistributing.

## Why

Three things are broken when you actually work with AI agents:

- **Tickets are too thin.** A one-line task doesn't carry the context an agent
  needs to do it right.
- **Chats aren't a workflow.** A scrollback isn't a board you can claim, move,
  review, and complete.
- **Memory is stuck inside vendors.** Provider memory is capped, cloud-bound,
  injected into every turn, and not portable between models.

Morion is the layer below all of it: a durable, local workspace that both you
and your agents author — built to outlive any one tool or model.

## What's inside — one app, four layers

1. **Notebook.** Apple Notes-grade editor, markdown bodies on disk, instant
   FTS + semantic search. Open it every day; it's a notes app first.
2. **Task board.** Turn any folder into a kanban board. Humans *and* AI agents
   claim cards, move them through `todo → doing → review → done`, and comment —
   a shared queue, not a chat log.
3. **Mo — the context engine.** The `mo_*` tools gather the right notes,
   tickets, decisions, and recent activity and hand an agent a packaged brief
   instead of a thin prompt. (Bring your own LLM key.)
4. **Auto-code harness.** Compose **build → review → decide → complete** loops
   that drive CLI agents and merge into your repo. (Optional, bring your own key.)

All four share **one local workspace** — a SQLite database (notes, tasks, tags,
metadata) plus an `attachments/` folder under your config dir. Only what an
agent explicitly searches for via `notes_search` enters its context window —
gigabyte-scale base, full documents, targeted retrieval, no recurring token
cost. And every MCP write lands in `audit_log` with the calling client name, so
you always know which assistant wrote what.

## Quickstart (browser-local)

```bash
git clone https://github.com/miksushko/morion-oss.git
cd morion-oss
npm install
npm run dev
# UI:      http://localhost:5173
# sidecar: http://localhost:7778
```

`npm run dev` starts the Vite UI (5173) and the Node sidecar (7778) together.
In browser-local mode there's no auth token — the sidecar binds to loopback and
treats an unset `MORION_API_TOKEN` as "auth disabled". Your database lives under
the OS config dir (override with `MORION_CONFIG_DIR`).

Prefer a one-click install? Grab a signed desktop build at **https://morion.ai**.

### Production server (no GUI)

```bash
npm run build
node dist/cli/index.js init     # writes config + runs migrations
node dist/cli/index.js serve    # HTTP only, loopback
node dist/cli/index.js mcp      # MCP stdio, in a separate process
```

The HTTP server and the MCP stdio server are separate processes so JSON-RPC on
stdout stays uncorrupted. They share the same SQLite file via WAL mode.

### Sample vault

```bash
node dist/cli/index.js import md sample-vault
```

## Connect an LLM client

`morion mcp` is a stdio MCP server — point any MCP-capable client at it (run
`npm run build` first so `dist/cli/index.js` exists).

### Claude Desktop / Claude Code / Cursor / Cline

```json
{
  "mcpServers": {
    "morion": {
      "command": "node",
      "args": ["/ABS/PATH/TO/morion-oss/dist/cli/index.js", "mcp"]
    }
  }
}
```

(Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`;
Claude Code: `~/.claude/settings.json`; Cursor: `~/.cursor/mcp.json`;
Cline: the "Edit MCP Settings" panel.)

### Zed

```json
{
  "context_servers": {
    "morion": {
      "command": { "path": "node", "args": ["/ABS/PATH/TO/morion-oss/dist/cli/index.js", "mcp"] },
      "settings": {}
    }
  }
}
```

### Custom DB location

```json
"env": { "MORION_CONFIG_DIR": "/Users/you/Documents/morion-data" }
```

## MCP tools

Grouped by domain:

- **Notes:** `notes_search`, `notes_list`, `notes_get`, `notes_create`,
  `notes_update`, `notes_delete`, `notes_append`, `notes_duplicate`,
  `notes_move`, `notes_recent`
- **Tasks / kanban:** `tasks_list`, `tasks_claim` (atomically take a card),
  `tasks_move` (advance through columns + comment), `tasks_history`
- **Folders:** `folders_list`, `folders_create`, `folders_rename`,
  `folders_delete`, `folders_duplicate`, `folders_move`, `folders_reorder`,
  `folders_set_view_mode` (flip a folder to a kanban board)
- **Tags:** `tags_list`, `tags_create`, `tags_update`, `tags_delete`
- **Audit:** `audit_recent` — "what did Claude write to my notes today?"
- **Mo agent (`mo_*`):** deep-research context gather (`mo_get_context`,
  `mo_ask`), hybrid search (`mo_search`), workspace memory (`mo_remember` /
  `mo_forget`), plus index-maintenance helpers. Mo is free — enable it per
  folder and bring your own LLM key. It runs on any configured backend
  (OpenRouter / OpenAI / Anthropic / Groq / local Ollama); **OpenRouter** ships
  built-in model defaults so it works with zero extra config, while the other
  backends need you to set the pipeline tier1 + tier2 models in Settings → Mo.
  `mo_search` needs no LLM — it's local hybrid search.

Every MCP mutation writes to `audit_log` with the calling client name
(`mcp:<client>`).

## MCP bundle (.mcpb)

```bash
npm run package:mcpb
```

Builds a `.mcpb` for the Claude Desktop MCP directory (FTS-only slim runtime,
no embedding model).

## Stack

- **TypeScript** (strict, ESM, Node 20+) end-to-end.
- **better-sqlite3** + **sqlite-vec** + **FTS5** + RRF hybrid search.
- **@huggingface/transformers** (ONNX, in-process) for embeddings — no daemon,
  no API key, no network after first run.
- **@modelcontextprotocol/sdk** over stdio.
- **hono** + `@hono/node-server` bound to `127.0.0.1`.
- **React 18** + **Vite** + **Tailwind** + **Tiptap 3** with `tiptap-markdown`.

The desktop app is a Tauri 2 shell wrapping this same core, built from a
separate repo and distributed from morion.ai.

## Local-first, zero lock-in

- Markdown note bodies in a SQLite database, with image attachments as plain
  files alongside it — readable by anything, exportable anywhere. To back up or
  move a workspace, copy the config dir (`MORION_CONFIG_DIR`): the `.db` plus the
  `attachments/` folder. `morion export <dir>` also dumps every note to markdown
  with frontmatter.
- No cloud, no account, no telemetry.
- Loopback-only HTTP; search + embeddings run in-process, fully offline (the
  embedding model loads once, then no network). Mo's LLM context engine needs a
  provider key for whichever backend you pick — or point it at a local Ollama
  server to stay fully offline there too.

## Building & testing

```bash
npm run typecheck   # tsc --noEmit (server + core; src/web is built by Vite)
npm run build       # tsc + vite
npm test            # vitest
```

## Using this in your own product

You may fork and redistribute the code under Apache 2.0, but you **must
rebrand** the product name, logo, and domain. The technical identifiers
(`mo_*` tools, `X-Morion-Token`, `morion://`, `MORION_*`, …) may be kept as-is.
See **TRADEMARK.md**. Official, code-signed builds are produced only by the
project owner via morion.ai.

## License

Apache License 2.0 — see `LICENSE`. The Morion / Mo names, logos, the morion.ai
domain, and the morion-releases repository are reserved; see `NOTICE` and
`TRADEMARK.md`.

Third-party open-source dependencies and their licenses are listed in
`THIRD_PARTY_NOTICES.md` (regenerate with `node scripts/gen-third-party-notices.mjs`).

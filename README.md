# Morion Community

**The open-source edition of Morion: a local notebook and kanban board that your
AI agents read and write over MCP.**

You write notes and move tasks in a real notes app. Claude Code, Codex, Cursor,
Cline, Zed or any other MCP client reads, searches and writes the **same local
SQLite file** next to you, and every change an agent makes is logged with its
name. No account, no cloud: your notes stay on your disk.

Morion Community runs from source in your browser on localhost and is licensed
under Apache 2.0.

> **Looking for the full Morion?** Morion 2.0 is the desktop app for macOS,
> Windows and Linux at **[morion.ai](https://morion.ai)**, with the newer
> engine:
>
> - **Smart retrieval.** When an agent takes a ticket or asks a question, Mo
>   reads it, searches your notes and hands over what the task needs, with the
>   reason. Nothing to index, nothing to wait for.
> - **Answers you can check.** Every claim cites the note it came from and
>   carries a status: decided, proposed, superseded and so on.
> - **Work packets.** One call gives an agent the ticket, the comments that
>   still matter, the project brief and the notes to read first.
> - **Projects, Mo Assistant, and Auto-code** with branching workflows, a human
>   gate you answer in chat, and a Re-opened column that sends work back with a
>   reason.
> - **AI included in Pro, no API key.** A Free plan covers notes, the board and
>   1,000 MCP calls a month; every account starts with 14 days of Pro, no card.
>
> [Download Morion 2.0](https://morion.ai/download)

## What Morion Community includes

1. **Notebook.** A Markdown editor with instant full-text and semantic search.
   It is a notes app first; open it every day.
2. **Kanban board.** Turn any folder into a board. You and your agents claim
   cards, move them through `todo → doing → review → done` and comment on them:
   a shared queue instead of a chat log.
3. **MCP server.** Point any MCP client at the stdio server (config below).
   Per-folder permissions decide what agents may see and change; the audit log
   records who wrote what.
4. **Mo chat and indexing** on the earlier engine, with your own model key.
5. **Auto-code workflows.** A visual editor, five templates, and the `claude`,
   `codex`, `opencode` and `pi` agents driving build → review → merge loops in
   your repo.

### Community and Morion 2.0 side by side

| | Community | Morion 2.0 |
|---|---|---|
| Notes, kanban, Markdown import and export | yes | yes |
| MCP server, per-folder permissions, audit log | yes | yes |
| One-click agent connection with the Morion skill | no, a config snippet | yes |
| Mo | chat and indexing with your own key | smart retrieval, cited answers with a status per claim, work packets, Mo Assistant; AI included in Pro |
| Projects | no | yes |
| Auto-code | workflows, templates, CLI agents | plus branching runs, a conversational human gate, the Re-opened column |
| Where it runs | from source, in your browser | desktop app for macOS, Windows and Linux |
| Account and plans | none | Free, Pro, Enterprise |
| License | Apache 2.0 | commercial |

## Quickstart

```bash
git clone https://github.com/miksushko/morion-oss.git
cd morion-oss
npm install
npm run dev
# UI:      http://localhost:5173
# sidecar: http://localhost:7778
```

`npm run dev` starts the Vite UI (5173) and the Node sidecar (7778) together.
The sidecar binds to loopback only; without `MORION_API_TOKEN` set it runs
without an auth token. Your database lives under the OS config dir (override
with `MORION_CONFIG_DIR`).

### Server without the UI

```bash
npm run build
node dist/cli/index.js init     # writes config + runs migrations
node dist/cli/index.js serve    # HTTP only, loopback
node dist/cli/index.js mcp      # MCP stdio, in a separate process
```

The HTTP server and the MCP stdio server are separate processes so JSON-RPC on
stdout stays clean. They share the same SQLite file in WAL mode.

### Sample vault

```bash
node dist/cli/index.js import md sample-vault
```

## Connect an agent

`morion mcp` is a stdio MCP server. Point any MCP client at it (run
`npm run build` first so `dist/cli/index.js` exists).

### Claude Desktop, Claude Code, Cursor, Cline

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
Claude Code: `~/.claude.json`; Cursor: `~/.cursor/mcp.json`; Cline: the
"Edit MCP Settings" panel.)

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

### Custom database location

```json
"env": { "MORION_CONFIG_DIR": "/Users/you/Documents/morion-data" }
```

## MCP tools

- **Notes:** `notes_search`, `notes_list`, `notes_get`, `notes_create`,
  `notes_update`, `notes_delete`, `notes_append`, `notes_duplicate`,
  `notes_move`, `notes_recent`
- **Tasks:** `tasks_list`, `tasks_claim` (take a card atomically), `tasks_move`
  (move through columns with a comment), `tasks_history`
- **Folders:** `folders_list`, `folders_create`, `folders_rename`,
  `folders_delete`, `folders_duplicate`, `folders_move`, `folders_reorder`,
  `folders_set_view_mode` (turn a folder into a board)
- **Tags:** `tags_list`, `tags_create`, `tags_update`, `tags_delete`
- **Audit:** `audit_recent`: "what did my agent write today?"
- **Mo:** `mo_ask`, `mo_search` (local hybrid search, no model call),
  `mo_remember` / `mo_forget` and more. Mo needs a model key for the backend
  you pick in Settings, or a local Ollama server to stay fully offline.

Every MCP change writes to `audit_log` with the calling client's name.

### MCP bundle (.mcpb)

```bash
npm run package:mcpb
```

Builds a `.mcpb` for the Claude Desktop MCP directory (full-text search only,
no embedding model).

## Local-first

- Markdown note bodies in one SQLite file, attachments as plain files next to
  it. To back up or move a workspace, copy the config dir (`MORION_CONFIG_DIR`).
  `morion export <dir>` writes every note to Markdown with frontmatter.
- Morion Community sends no telemetry and needs no account.
- HTTP on loopback only; search and embeddings run in-process and offline after
  the embedding model's first download.

## Stack

- **TypeScript** (strict, ESM, Node 20+) end to end.
- **better-sqlite3** + **sqlite-vec** + **FTS5**, hybrid search with RRF.
- **@huggingface/transformers** (ONNX, in-process) for embeddings.
- **@modelcontextprotocol/sdk** over stdio.
- **hono** + `@hono/node-server` bound to `127.0.0.1`.
- **React 18** + **Vite** + **Tailwind** + **Tiptap 3** with `tiptap-markdown`.

## Building and testing

```bash
npm run typecheck   # tsc --noEmit (server + core)
npm run build       # tsc + vite
npm test            # vitest
```

## Contributing

Issues and pull requests are welcome. Morion Community takes bug, security and
compatibility fixes; new features ship in Morion 2.0. See `CONTRIBUTING.md` and
`SECURITY.md`.

## Forks and the Morion name

The code is yours to use, fork and redistribute under Apache 2.0. The name is
not:

- **Rebrand any fork you distribute.** Do not ship it as "Morion" or "Mo", do
  not use the Morion or Mo logos or the morion.ai domain, and do not present it
  as the official app or as affiliated with Morion.
- You may say your product "is based on Morion" or "is a fork of Morion Community".
- Technical identifiers such as the `mo_*` tool names, `X-Morion-Token`,
  `morion://` and `MORION_*` variables may stay as they are.

Official Morion builds come only from [morion.ai](https://morion.ai). Details in
`TRADEMARK.md`.

## License

Apache License 2.0, see `LICENSE`. The Morion and Mo names and logos, the
morion.ai domain and the official releases repositories are reserved; see
`NOTICE` and `TRADEMARK.md`.

Third-party open-source dependencies and their licenses are listed in
`THIRD_PARTY_NOTICES.md` (regenerate with `node scripts/gen-third-party-notices.mjs`).

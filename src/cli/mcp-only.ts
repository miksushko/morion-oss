#!/usr/bin/env node
/**
 * Morion MCP stdio server — the one-purpose binary that ships inside the
 * `.mcpb` (MCP Bundle) for the Anthropic directory. No flags, no
 * subcommands, no HTTP: Claude Desktop spawns this with stdin/stdout as
 * the JSON-RPC channel and that's the whole contract.
 *
 * Shares the same SQLite DB as the installed Morion.app (WAL mode makes
 * concurrent reads/writes safe between the app's own embedded MCP sidecar
 * and this bundle-shipped one). If the user has the app, notes written
 * through either path show up in both. If the user has only this bundle,
 * it works standalone against a bundle-local DB.
 *
 * CRITICAL: stdout carries the MCP protocol — any stray `console.log`
 * here corrupts the stream and Claude Desktop will refuse to load the
 * extension. Route all logs to `process.stderr`.
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildSlimRuntime } from '../core/runtime-slim.js';
import { startMcpStdio } from '../server/bootstrap/mcp.js';

async function main() {
  // Default DB location matches Morion.app so the two share one notebook
  // when both are installed (SQLite WAL mode is multi-process safe). User
  // can override with MORION_CONFIG_DIR env. Without this, the bundle's
  // cwd (Claude Desktop extension dir) becomes the DB root, which would
  // stealthily fork the notebook into a second database.
  if (!process.env.MORION_CONFIG_DIR) {
    if (process.platform === 'darwin') {
      process.env.MORION_CONFIG_DIR = join(
        homedir(),
        'Library',
        'Application Support',
        'com.morion.Morion',
      );
    } else if (process.platform === 'win32') {
      process.env.MORION_CONFIG_DIR = join(
        process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
        'com.morion.Morion',
      );
    } else {
      // Linux / BSD — XDG data dir fallback
      process.env.MORION_CONFIG_DIR = join(
        process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
        'com.morion.Morion',
      );
    }
  }

  const rt = buildSlimRuntime();
  process.stderr.write(`morion mcp (bundle) | db: ${rt.config.dbPath}\n`);
  await startMcpStdio({
    db: rt.handle.db,
    notes: rt.notes,
    folders: rt.folders,
    tags: rt.tags,
    revisions: rt.revisions,
    attachments: rt.attachments,
    comments: rt.comments,
    search: rt.search,
    indexer: rt.indexer,
    embeddings: rt.embeddings,
    audit: rt.audit,
    settings: rt.settings,
    configDir: dirname(rt.config.dbPath),
    // Mo Context Broker (`mo_*` tools) needs the concierge bag to
    // check per-folder enablement + read project briefs. The slim
    // runtime exposes the same shape as full runtime so the bundle
    // path supports the family identically to the desktop sidecar.
    concierge: rt.concierge,
  });
}

main().catch((err) => {
  process.stderr.write(`morion mcp (bundle) fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});

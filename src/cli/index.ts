#!/usr/bin/env node
import { Command } from 'commander';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildRuntime } from '../core/runtime.js';
import { configPaths, defaultConfig, saveConfig } from '../core/config.js';
import { MarkdownImporter } from '../core/importers/markdown.js';
import { startHttpServer } from '../server/bootstrap/start.js';
import { startMcpStdio } from '../server/bootstrap/mcp.js';
import {
  watchParentViaPpid,
  watchParentViaStdioAndPpid,
} from '../server/bootstrap/orphan-watch.js';
import { APP_VERSION } from '../core/version.js';
import type { Note } from '../core/notes/types.js';
import type { ClientStatus } from '../core/mcp-install/types.js';

const program = new Command();
program
  .name('morion')
  .description('Local notebook + MCP memory server')
  .version(APP_VERSION);

program
  .command('init')
  .description('Write the default config file and run pending migrations')
  .action(() => {
    const paths = configPaths();
    if (existsSync(paths.configFile)) {
      console.log(`config already exists at ${paths.configFile}`);
    } else {
      saveConfig(defaultConfig());
      console.log(`wrote ${paths.configFile}`);
    }
    // Open the DB once to apply migrations and (best-effort) load sqlite-vec.
    const rt = buildRuntime();
    console.log(`db ready: ${rt.config.dbPath}`);
    console.log(`vec extension loaded: ${rt.handle.hasVec}`);
    rt.handle.db.close();
  });

program
  .command('serve')
  .description('Run the HTTP server (loopback only). For UI use.')
  .action(() => {
    // Thin wrapper around startHttpServer — the same function powers
    // `npm run dev:server` via `src/server/index.ts`. See R3 2026-04-17
    // and lessons.md 2026-04-14 "Duplicated server entrypoints drifted".
    const rt = buildRuntime();
    const started = startHttpServer(rt);

    // Graceful shutdown. The Tauri wrapper sends SIGTERM on window close
    // and only SIGKILLs after a 2s grace period (see src-tauri/src/main.rs
    // on_window_event). Flush SQLite's WAL via db.close() so FTS5 doesn't
    // end up in a half-written state (lessons.md 2026-04-12).
    //
    // Await the shutdown promise so the scheduler's inflight ticks +
    // brief digests finish before process.exit cuts the event loop.
    // Tauri's 2s grace is plenty for normal completion. Ticket
    // `01KQ1H4YVKJFVE05PG9WZBAB7E`.
    const shutdown = async (signal: string): Promise<void> => {
      console.log(`[morion] ${signal} received, closing DB and exiting`);
      await started.shutdown();
      process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    // Orphan detection: when the Tauri shell process dies WITHOUT
    // running its `WindowEvent::Destroyed` cleanup (force-quit,
    // crash, App Nap kill, system sleep glitch), our SIGTERM
    // handler above never fires. Without ppid polling, the zombie
    // sidecar keeps the scheduler alive and (if running pre-fix
    // code) burns the user's LLM budget on autonomous ticks
    // until reboot. Ticket `01KQVA65TJ2VCY8VCKH9N5F6W8`.
    watchParentViaPpid({
      onOrphan: (reason) => void shutdown(`orphan(${reason})`),
    });
  });

program
  .command('mcp')
  .description('Run the MCP stdio transport. For Claude Desktop / Cursor / Cline / Zed to spawn.')
  .action(async () => {
    // CRITICAL: stdio MCP owns stdout. Any console.log here corrupts the JSON-RPC
    // stream. Route all logs to stderr.
    const rt = buildRuntime();
    process.stderr.write(`morion MCP stdio | db: ${rt.config.dbPath}\n`);

    // Orphan detection for stdio sidecars. When the MCP client
    // (Claude Desktop, Cursor, Codex, Antigravity, Cline) dies
    // without closing our stdio pipe cleanly, ppid polling catches
    // re-parenting to init and exits us. The stdin EOF watcher is
    // the fast path — fires within ms when the parent does close
    // the pipe (every well-behaved client). Both layers run for
    // defence in depth. Same ticket as the HTTP-sidecar guard:
    // `01KQVA65TJ2VCY8VCKH9N5F6W8`.
    watchParentViaStdioAndPpid({
      onOrphan: (reason) => {
        process.stderr.write(`[morion mcp] parent gone (${reason}), exiting\n`);
        try {
          rt.handle.db.close();
        } catch (e) {
          process.stderr.write(`[morion mcp] db close failed: ${(e as Error).message}\n`);
        }
        process.exit(0);
      },
    });

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
      // check per-folder enablement + read project briefs. Without
      // this, mo_* tools return `mo_internal:concierge_not_wired`.
      concierge: rt.concierge,
    });
  });

const importCmd = program.command('import').description('Import notes from external sources');

importCmd
  .command('md <vaultPath>')
  .description('Import a directory of markdown files (Obsidian-compatible)')
  .option('--source <name>', 'Source label written to notes.source', 'import:markdown')
  .action(async (vaultPath: string, opts: { source: string }) => {
    const abs = resolve(vaultPath);
    if (!existsSync(abs)) {
      console.error(`vault not found: ${abs}`);
      process.exit(1);
    }
    const rt = buildRuntime();
    const importer = new MarkdownImporter(rt.notes, rt.folders, rt.indexer);
    console.log(`importing markdown from ${abs} ...`);
    const summary = await importer.import({ vaultPath: abs, source: opts.source });
    console.log(
      `done: scanned=${summary.scanned} imported=${summary.imported} skipped=${summary.skipped} errors=${summary.errors.length}`,
    );
    for (const err of summary.errors) console.error(`  ${err.file}: ${err.error}`);
    rt.handle.db.close();
  });

program
  .command('export <outDir>')
  .description('Export notes to a directory of markdown files grouped by folder')
  .action((outDir: string) => {
    const abs = resolve(outDir);
    mkdirSync(abs, { recursive: true });

    const rt = buildRuntime();
    const folderById = new Map(rt.folders.list().map((f) => [f.id, f]));

    let written = 0;
    let offset = 0;
    const limit = 500;
    while (true) {
      const batch = rt.notes.list({ limit, offset });
      if (batch.length === 0) break;
      for (const note of batch) {
        const folder = note.folderId ? folderById.get(note.folderId) : null;
        const folderDir = folder ? join(abs, folder.name) : join(abs, 'inbox');
        mkdirSync(folderDir, { recursive: true });
        const fileName = `${slugify(note.title) || note.id}.md`;
        const filePath = join(folderDir, fileName);
        writeFileSync(filePath, renderMarkdown(note), 'utf8');
        written += 1;
      }
      if (batch.length < limit) break;
      offset += limit;
    }

    console.log(`exported ${written} notes to ${abs}`);
    rt.handle.db.close();
  });

// ---------- LLM client install ----------
//
// Wires the prod-app launcher into known LLM client config files
// (Claude Desktop, Cursor, Claude Code, Cline). Same logic as the HTTP
// endpoints — both paths share src/core/mcp-install/installer.ts.
//
// Resolves the launcher from process.argv[1] when running via the bundled
// CLI; otherwise (dev / standalone node) prints a clear message rather
// than wiring a clients to a session that may not exist.

function resolveLauncherForCli(): string | null {
  const execPath = process.execPath;
  const scriptPath = process.argv[1] ?? '';
  if (!execPath.includes('.app/Contents/')) return null;
  const m = scriptPath.match(/^(.*)\/app\/cli\/index\.(?:js|mjs|cjs)$/);
  if (!m) return null;
  return `${m[1]}/morion`;
}

function statusLabel(s: ClientStatus): string {
  switch (s.kind) {
    case 'installed-current':
      return 'Connected';
    case 'installed-stale':
      return 'Connected (stale — re-install to update)';
    case 'not-installed':
      return s.reason === 'no-config-file' ? 'Not installed (no config file)' : 'Not installed';
    case 'config-malformed':
      return `Config malformed: ${s.error}`;
  }
}

program
  .command('install')
  .description('Install Morion into one or more LLM clients')
  .argument('[client]', 'client id (claude-desktop, cursor, claude-code, cline, antigravity, zed, windsurf, codex) — omit for --all')
  .option('--all', 'install into every supported client')
  .action(async (clientId: string | undefined, opts: { all?: boolean }) => {
    const { ADAPTERS, findAdapter } = await import('../core/mcp-install/adapters.js');
    const { install: doInstall, entryForLauncher } = await import('../core/mcp-install/installer.js');
    const { CODEX_ADAPTER, codexInstall } = await import('../core/mcp-install/codex.js');
    const launcher = resolveLauncherForCli();
    if (launcher === null) {
      console.error(
        'morion install requires the bundled .app launcher.\n' +
          'Build/install Morion.app, then run:\n' +
          '  /Applications/Morion.app/Contents/Resources/resources/sidecar/morion install <client>',
      );
      process.exit(2);
    }
    const allIds = [...ADAPTERS.map((a) => a.id), CODEX_ADAPTER.id];
    const runOne = (_id: string, displayName: string, fn: () => { configPath: string; backupPath: string | null }): void => {
      try {
        const result = fn();
        console.log(`✓ ${displayName} → ${result.configPath}`);
        if (result.backupPath) console.log(`  backup: ${result.backupPath}`);
      } catch (err) {
        console.error(`✗ ${displayName}: ${(err as Error).message}`);
      }
    };
    const entry = entryForLauncher(launcher);
    if (opts.all) {
      for (const a of ADAPTERS) runOne(a.id, a.displayName, () => doInstall(a, entry));
      runOne(CODEX_ADAPTER.id, CODEX_ADAPTER.displayName, () => codexInstall(entry));
    } else if (clientId === CODEX_ADAPTER.id) {
      runOne(CODEX_ADAPTER.id, CODEX_ADAPTER.displayName, () => codexInstall(entry));
    } else if (clientId) {
      const a = findAdapter(clientId);
      if (!a) {
        console.error(`unknown client: ${clientId}`);
        console.error(`known: ${allIds.join(', ')}`);
        process.exit(2);
      }
      runOne(a.id, a.displayName, () => doInstall(a, entry));
    } else {
      console.error('usage: morion install <client> | --all');
      console.error(`known: ${allIds.join(', ')}`);
      process.exit(2);
    }
    console.log('\nRestart the client(s) to activate Morion.');
  });

program
  .command('uninstall')
  .description('Remove Morion from one or more LLM clients')
  .argument('[client]', 'client id — omit for --all')
  .option('--all', 'uninstall from every supported client')
  .action(async (clientId: string | undefined, opts: { all?: boolean }) => {
    const { ADAPTERS, findAdapter } = await import('../core/mcp-install/adapters.js');
    const { uninstall: doUninstall } = await import('../core/mcp-install/installer.js');
    const { CODEX_ADAPTER, codexUninstall } = await import('../core/mcp-install/codex.js');
    const runOne = (displayName: string, fn: () => { backupPath: string | null }): void => {
      try {
        const r = fn();
        if (r.backupPath) console.log(`✓ ${displayName} → removed (backup: ${r.backupPath})`);
        else console.log(`- ${displayName} → was not installed`);
      } catch (err) {
        console.error(`✗ ${displayName}: ${(err as Error).message}`);
      }
    };
    if (opts.all) {
      for (const a of ADAPTERS) runOne(a.displayName, () => doUninstall(a));
      runOne(CODEX_ADAPTER.displayName, () => codexUninstall());
    } else if (clientId === CODEX_ADAPTER.id) {
      runOne(CODEX_ADAPTER.displayName, () => codexUninstall());
    } else if (clientId) {
      const a = findAdapter(clientId);
      if (!a) {
        console.error(`unknown client: ${clientId}`);
        process.exit(2);
      }
      runOne(a.displayName, () => doUninstall(a));
    } else {
      console.error('usage: morion uninstall <client> | --all');
      process.exit(2);
    }
  });

program
  .command('mcp-status')
  .description('Show which LLM clients have Morion configured')
  .action(async () => {
    const { ADAPTERS } = await import('../core/mcp-install/adapters.js');
    const { status: doStatus, entryForLauncher } = await import('../core/mcp-install/installer.js');
    const { CODEX_ADAPTER, codexStatus } = await import('../core/mcp-install/codex.js');
    const launcher = resolveLauncherForCli();
    if (launcher === null) {
      console.error('Run from the bundled .app launcher to see status.');
      process.exit(2);
    }
    const entry = entryForLauncher(launcher);
    for (const a of ADAPTERS) {
      const s = doStatus(a, entry);
      console.log(`${a.displayName.padEnd(20)} ${statusLabel(s)}`);
      console.log(`  ${a.configPath()}`);
    }
    // Codex — separate codec (TOML), same status shape.
    const cs = codexStatus(entry);
    console.log(`${CODEX_ADAPTER.displayName.padEnd(20)} ${statusLabel(cs)}`);
    console.log(`  ${CODEX_ADAPTER.configPath()}`);
  });

program.parseAsync().catch((err) => {
  console.error(err);
  process.exit(1);
});

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function renderMarkdown(note: Note): string {
  const fm: string[] = ['---'];
  fm.push(`title: ${yamlString(note.title)}`);
  if (note.tags.length > 0) {
    fm.push(`tags: [${note.tags.map(yamlString).join(', ')}]`);
  }
  fm.push(`source: ${yamlString(note.source)}`);
  fm.push(`created: ${new Date(note.createdAt).toISOString()}`);
  fm.push(`updated: ${new Date(note.updatedAt).toISOString()}`);
  fm.push('---');
  fm.push('');
  fm.push(note.body);
  return fm.join('\n');
}

function yamlString(value: string): string {
  // Quote if it contains anything yaml-special; otherwise leave bare for readability.
  if (/^[A-Za-z0-9_\-./ ]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}


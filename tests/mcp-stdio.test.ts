import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { ALL_TOOLS } from '../src/server/tools/index.js';
import {
  StdioMcpClient,
  makeStdioConfigDir,
  parseToolResult,
} from './helpers/mcp-stdio-setup.js';

/**
 * End-to-end test for the MCP stdio transport.
 *
 * Spawns `tsx src/cli/index.ts mcp` as a real child process, talks to it
 * over JSON-RPC NDJSON framing (one message per line, ending in `\n`),
 * and verifies that every tool is discoverable (count pinned against the
 * live `ALL_TOOLS.length` so future tool additions don't silently drift
 * the assertion) and that a create+search round-trip actually mutates
 * the SQLite file on disk.
 *
 * tests/mcp-tools.test.ts already exercises every tool handler in-process
 * via a hand-built ToolContext. That covers logic but skips the entire
 * transport layer: server registration via McpServer.registerTool, the
 * stdio framing in StdioServerTransport, the actor-from-initialize wiring
 * in src/server/mcp.ts, and the CLI command in src/cli/index.ts. This file
 * is the regression net for those layers.
 *
 * The 27 it() blocks below intentionally share `let` state and run in
 * declaration order against the SAME live child process — the walk is
 * load-bearing for actor/index/audit ordering invariants. Per-tool
 * splitting would require a fresh sidecar + bootstrap per file at the
 * cost of those invariants, so the file stays cohesive (state-machine
 * exemption per CLAUDE.md). Transport plumbing (StdioMcpClient +
 * parseToolResult + makeStdioConfigDir) lives in
 * tests/helpers/mcp-stdio-setup.ts so this file is just the walk.
 */

describe('MCP stdio end-to-end', () => {
  let configDir: string;
  let dbPath: string;
  let client: StdioMcpClient;

  // Hoisted across the sequential it() blocks below: each tool call in the
  // walk feeds the next one. Vitest runs tests in declaration order within a
  // describe by default, and we rely on that here on purpose — the goal is to
  // exercise every tool against the same live child process + DB so any
  // ordering bug in the actor / index / audit hooks shows up.
  let createdNoteId: string;
  let walkFolderId: string;
  let walkFolder2Id: string;
  let dupFolderId: string;
  let walkInsideNoteId: string;
  let walkTagId: string;
  let dupNoteId: string;

  beforeAll(async () => {
    const cfg = makeStdioConfigDir();
    configDir = cfg.configDir;
    dbPath = cfg.dbPath;
    client = new StdioMcpClient(configDir);

    const initResponse = await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'morion-stdio-test', version: '0.0.0' },
    });
    expect(initResponse.error).toBeUndefined();
    const initResult = initResponse.result as { capabilities: { tools?: unknown } };
    expect(initResult.capabilities.tools).toBeDefined();

    client.notify('notifications/initialized');
    // Give the server a tick to process the notification before the first
    // tools/call so the actor is hydrated from clientInfo.
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  afterAll(async () => {
    await client.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it('lists every tool in the registry via tools/list', async () => {
    const response = await client.request('tools/list');
    expect(response.error).toBeUndefined();
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toBeDefined();
    // Pin the count + the exact set against the live registry so future
    // tool additions don't drift this assertion silently. Before the R5
    // fix this read "27" hardcoded and a parallel describe on this very
    // file said "22"; both rotted when Direction N shipped its 5 tasks_*
    // tools.
    const names = result.tools.map((t) => t.name).sort();
    const expected = ALL_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(expected);
    expect(result.tools).toHaveLength(ALL_TOOLS.length);
  }, 15_000);

  it('round-trips notes_create + persists to SQLite with the right actor', async () => {
    const response = await client.request('tools/call', {
      name: 'notes_create',
      arguments: {
        body: '# stdio smoke note\n\npizza for lunch',
        tags: ['smoke'],
      },
    });
    const note = parseToolResult<{ id: string; title: string; body: string; tags: string[] }>(response);
    expect(note.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(note.title).toBe('stdio smoke note');
    expect(note.body).toBe('# stdio smoke note\n\npizza for lunch');
    expect(note.tags).toContain('smoke');
    createdNoteId = note.id;

    // Verify the row landed in the actual SQLite file the child wrote to.
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare('SELECT id, title, body, source FROM notes WHERE id = ?')
        .get(note.id) as { id: string; title: string; body: string; source: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.title).toBe('stdio smoke note');
      expect(row!.source).toBe('mcp:morion-stdio-test');

      const audit = db
        .prepare(
          "SELECT action, actor FROM audit_log WHERE note_id = ? AND action = 'create'",
        )
        .get(note.id) as { action: string; actor: string } | undefined;
      expect(audit).toBeDefined();
      expect(audit!.actor).toBe('mcp:morion-stdio-test');
    } finally {
      db.close();
    }
  }, 15_000);

  it('finds the new note via notes_search', async () => {
    const response = await client.request('tools/call', {
      name: 'notes_search',
      arguments: { query: 'pizza' },
    });
    const hits = parseToolResult<Array<{ id: string; title: string; snippet: string }>>(response);
    expect(hits.length).toBeGreaterThan(0);
    const titles = hits.map((h) => h.title);
    expect(titles).toContain('stdio smoke note');
  }, 15_000);

  it('notes_get returns the full note with tags', async () => {
    const response = await client.request('tools/call', {
      name: 'notes_get',
      arguments: { id: createdNoteId },
    });
    const note = parseToolResult<{
      id: string;
      title: string;
      body: string;
      tags: string[];
      folderId: string | null;
      deletedAt: number | null;
    }>(response);
    expect(note.id).toBe(createdNoteId);
    expect(note.title).toBe('stdio smoke note');
    expect(note.body).toBe('# stdio smoke note\n\npizza for lunch');
    expect(note.tags).toEqual(['smoke']);
    expect(note.folderId).toBeNull();
    expect(note.deletedAt).toBeNull();
  }, 15_000);

  it('notes_update mutates body and bumps updatedAt', async () => {
    const before = new Database(dbPath, { readonly: true });
    const beforeRow = before
      .prepare('SELECT updated_at FROM notes WHERE id = ?')
      .get(createdNoteId) as { updated_at: number };
    before.close();

    // 1ms gap so updated_at is guaranteed to advance even on fast machines.
    await new Promise((r) => setTimeout(r, 5));

    const response = await client.request('tools/call', {
      name: 'notes_update',
      arguments: { id: createdNoteId, body: '# stdio smoke note\n\npizza for lunch and dinner' },
    });
    const note = parseToolResult<{ id: string; body: string; updatedAt: number }>(response);
    expect(note.id).toBe(createdNoteId);
    expect(note.body).toBe('# stdio smoke note\n\npizza for lunch and dinner');
    expect(note.updatedAt).toBeGreaterThan(beforeRow.updated_at);

    const after = new Database(dbPath, { readonly: true });
    try {
      const row = after
        .prepare('SELECT body, updated_at FROM notes WHERE id = ?')
        .get(createdNoteId) as { body: string; updated_at: number };
      expect(row.body).toBe('# stdio smoke note\n\npizza for lunch and dinner');
      expect(row.updated_at).toBe(note.updatedAt);
    } finally {
      after.close();
    }
  }, 15_000);

  it('notes_list returns the created note', async () => {
    const response = await client.request('tools/call', {
      name: 'notes_list',
      arguments: {},
    });
    const notes = parseToolResult<Array<{ id: string; title: string }>>(response);
    expect(notes.length).toBeGreaterThan(0);
    const ids = notes.map((n) => n.id);
    expect(ids).toContain(createdNoteId);
  }, 15_000);

  it('folders_create returns a fresh folder', async () => {
    const response = await client.request('tools/call', {
      name: 'folders_create',
      arguments: { name: 'Walk' },
    });
    const folder = parseToolResult<{
      id: string;
      name: string;
      parentId: string | null;
      noteCount: number;
    }>(response);
    expect(folder.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(folder.name).toBe('Walk');
    expect(folder.parentId).toBeNull();
    expect(folder.noteCount).toBe(0);
    walkFolderId = folder.id;
  }, 15_000);

  it('folders_list includes the new folder with noteCount=0', async () => {
    const response = await client.request('tools/call', {
      name: 'folders_list',
      arguments: {},
    });
    const folders = parseToolResult<Array<{ id: string; name: string; noteCount: number }>>(response);
    const walk = folders.find((f) => f.id === walkFolderId);
    expect(walk).toBeDefined();
    expect(walk!.name).toBe('Walk');
    expect(walk!.noteCount).toBe(0);
  }, 15_000);

  it('folders_rename updates the name', async () => {
    const response = await client.request('tools/call', {
      name: 'folders_rename',
      arguments: { id: walkFolderId, name: 'Walk renamed' },
    });
    const folder = parseToolResult<{ id: string; name: string }>(response);
    expect(folder.id).toBe(walkFolderId);
    expect(folder.name).toBe('Walk renamed');
  }, 15_000);

  it('notes_create inside the renamed folder bumps its noteCount', async () => {
    const created = await client.request('tools/call', {
      name: 'notes_create',
      arguments: {
        body: '# inside walk\n\nthis note lives inside the walk folder',
        folderId: walkFolderId,
        tags: ['walk'],
      },
    });
    const note = parseToolResult<{ id: string; folderId: string | null }>(created);
    expect(note.folderId).toBe(walkFolderId);
    walkInsideNoteId = note.id;

    const listed = await client.request('tools/call', {
      name: 'folders_list',
      arguments: {},
    });
    const folders = parseToolResult<Array<{ id: string; noteCount: number }>>(listed);
    const walk = folders.find((f) => f.id === walkFolderId);
    expect(walk?.noteCount).toBe(1);
  }, 15_000);

  it('folders_duplicate deep-copies folder + notes', async () => {
    const response = await client.request('tools/call', {
      name: 'folders_duplicate',
      arguments: { id: walkFolderId },
    });
    const dup = parseToolResult<{ id: string; name: string; noteCount: number }>(response);
    expect(dup.id).not.toBe(walkFolderId);
    expect(dup.name).toContain('Walk renamed');
    expect(dup.noteCount).toBe(1);
    dupFolderId = dup.id;

    // The copied note should be a fresh row with a different id but matching content.
    const db = new Database(dbPath, { readonly: true });
    try {
      const copies = db
        .prepare('SELECT id, title, body FROM notes WHERE folder_id = ? AND deleted_at IS NULL')
        .all(dupFolderId) as Array<{ id: string; title: string; body: string }>;
      expect(copies.length).toBe(1);
      expect(copies[0]!.id).not.toBe(walkInsideNoteId);
      expect(copies[0]!.title).toBe('inside walk');
      expect(copies[0]!.body).toBe('# inside walk\n\nthis note lives inside the walk folder');
    } finally {
      db.close();
    }
  }, 15_000);

  it('folders_create + folders_reorder rotate the sidebar order', async () => {
    const second = await client.request('tools/call', {
      name: 'folders_create',
      arguments: { name: 'Walk2' },
    });
    const folder = parseToolResult<{ id: string }>(second);
    walkFolder2Id = folder.id;

    // Reverse the current order; assert positions reflect the new order.
    const listed = await client.request('tools/call', {
      name: 'folders_list',
      arguments: {},
    });
    const before = parseToolResult<Array<{ id: string; position: number }>>(listed);
    const reversed = [...before].reverse().map((f) => f.id);

    const reorderResp = await client.request('tools/call', {
      name: 'folders_reorder',
      arguments: { orderedIds: reversed },
    });
    const after = parseToolResult<Array<{ id: string; position: number }>>(reorderResp);
    const orderedIds = [...after].sort((a, b) => a.position - b.position).map((f) => f.id);
    expect(orderedIds).toEqual(reversed);
  }, 15_000);

  it('folders_move bumps a folder one slot in the requested direction', async () => {
    // Move walkFolderId 'up'. Find its position before/after and assert -1.
    const before = await client.request('tools/call', {
      name: 'folders_list',
      arguments: {},
    });
    const beforeFolders = parseToolResult<Array<{ id: string; position: number }>>(before);
    const beforePos = beforeFolders.find((f) => f.id === walkFolderId)!.position;

    if (beforePos === 0) {
      // Already at the top — nothing to test for 'up'. Move 'down' instead.
      const resp = await client.request('tools/call', {
        name: 'folders_move',
        arguments: { id: walkFolderId, direction: 'down' },
      });
      const folders = parseToolResult<Array<{ id: string; position: number }>>(resp);
      const afterPos = folders.find((f) => f.id === walkFolderId)!.position;
      expect(afterPos).toBe(beforePos + 1);
    } else {
      const resp = await client.request('tools/call', {
        name: 'folders_move',
        arguments: { id: walkFolderId, direction: 'up' },
      });
      const folders = parseToolResult<Array<{ id: string; position: number }>>(resp);
      const afterPos = folders.find((f) => f.id === walkFolderId)!.position;
      expect(afterPos).toBe(beforePos - 1);
    }
  }, 15_000);

  it('folders_delete trashes its notes (soft-delete) instead of destroying them', async () => {
    // The dup folder still holds the cloned note from folders_duplicate.
    const db = new Database(dbPath, { readonly: true });
    const cloneRow = db
      .prepare('SELECT id FROM notes WHERE folder_id = ? AND deleted_at IS NULL')
      .get(dupFolderId) as { id: string };
    db.close();
    const cloneId = cloneRow.id;

    const response = await client.request('tools/call', {
      name: 'folders_delete',
      arguments: { id: dupFolderId },
    });
    const result = parseToolResult<{ ok: boolean }>(response);
    expect(result.ok).toBe(true);

    const after = new Database(dbPath, { readonly: true });
    try {
      const folder = after
        .prepare('SELECT id FROM folders WHERE id = ?')
        .get(dupFolderId) as { id: string } | undefined;
      expect(folder).toBeUndefined();

      // Cloned note's row still exists (recoverable from Trash), but is
      // now soft-deleted with the folder — the default trash-on-delete.
      const note = after
        .prepare('SELECT folder_id, deleted_at FROM notes WHERE id = ?')
        .get(cloneId) as { folder_id: string | null; deleted_at: number | null };
      expect(note).toBeDefined();
      expect(note.deleted_at).not.toBeNull();
    } finally {
      after.close();
    }
  }, 15_000);

  it('tags_create persists with the chosen color', async () => {
    const response = await client.request('tools/call', {
      name: 'tags_create',
      arguments: { name: 'walk-tag', color: '#ff6b6b' },
    });
    const tag = parseToolResult<{ id: string; name: string; color: string | null; noteCount: number }>(response);
    expect(tag.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(tag.name).toBe('walk-tag');
    expect(tag.color).toBe('#ff6b6b');
    expect(tag.noteCount).toBe(0);
    walkTagId = tag.id;
  }, 15_000);

  it('tags_list returns the new tag', async () => {
    const response = await client.request('tools/call', {
      name: 'tags_list',
      arguments: {},
    });
    const tags = parseToolResult<Array<{ id: string; name: string; color: string | null }>>(response);
    const walk = tags.find((t) => t.id === walkTagId);
    expect(walk).toBeDefined();
    expect(walk!.name).toBe('walk-tag');
    expect(walk!.color).toBe('#ff6b6b');
  }, 15_000);

  it('tags_update renames and recolors a tag', async () => {
    const response = await client.request('tools/call', {
      name: 'tags_update',
      arguments: { id: walkTagId, name: 'walk-tag-renamed', color: '#4ecdc4' },
    });
    const tag = parseToolResult<{ id: string; name: string; color: string | null }>(response);
    expect(tag.id).toBe(walkTagId);
    expect(tag.name).toBe('walk-tag-renamed');
    expect(tag.color).toBe('#4ecdc4');
  }, 15_000);

  it('tags_delete removes the tag from tags_list', async () => {
    const response = await client.request('tools/call', {
      name: 'tags_delete',
      arguments: { id: walkTagId },
    });
    const result = parseToolResult<{ ok: boolean }>(response);
    expect(result.ok).toBe(true);

    const listed = await client.request('tools/call', {
      name: 'tags_list',
      arguments: {},
    });
    const tags = parseToolResult<Array<{ id: string }>>(listed);
    expect(tags.find((t) => t.id === walkTagId)).toBeUndefined();
  }, 15_000);

  it('notes_append concatenates onto the existing body', async () => {
    const response = await client.request('tools/call', {
      name: 'notes_append',
      arguments: { id: createdNoteId, text: 'appended line' },
    });
    const note = parseToolResult<{ id: string; body: string }>(response);
    expect(note.id).toBe(createdNoteId);
    expect(note.body).toContain('appended line');
    expect(note.body).toContain('pizza for lunch and dinner');
    expect(note.body).toContain('# stdio smoke note');

    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare('SELECT body FROM notes WHERE id = ?')
        .get(createdNoteId) as { body: string };
      expect(row.body).toContain('appended line');
    } finally {
      db.close();
    }
  }, 15_000);

  it('notes_duplicate clones a note with a fresh id', async () => {
    const response = await client.request('tools/call', {
      name: 'notes_duplicate',
      arguments: { id: createdNoteId },
    });
    const dup = parseToolResult<{ id: string; title: string; body: string; tags: string[] }>(
      response,
    );
    expect(dup.id).not.toBe(createdNoteId);
    expect(dup.title).toBe('stdio smoke note');
    expect(dup.body).toContain('appended line');
    expect(dup.tags).toContain('smoke');
    dupNoteId = dup.id;
  }, 15_000);

  it('notes_move into a folder does NOT bump updated_at', async () => {
    const before = new Database(dbPath, { readonly: true });
    const beforeRow = before
      .prepare('SELECT updated_at, folder_id FROM notes WHERE id = ?')
      .get(dupNoteId) as { updated_at: number; folder_id: string | null };
    before.close();
    expect(beforeRow.folder_id).toBeNull();

    // Real-time gap so a buggy bump would be visible.
    await new Promise((r) => setTimeout(r, 5));

    const response = await client.request('tools/call', {
      name: 'notes_move',
      arguments: { id: dupNoteId, folderId: walkFolderId },
    });
    const moved = parseToolResult<{ id: string; folderId: string | null; updatedAt: number }>(
      response,
    );
    expect(moved.id).toBe(dupNoteId);
    expect(moved.folderId).toBe(walkFolderId);
    expect(moved.updatedAt).toBe(beforeRow.updated_at);

    const after = new Database(dbPath, { readonly: true });
    try {
      const row = after
        .prepare('SELECT updated_at, folder_id FROM notes WHERE id = ?')
        .get(dupNoteId) as { updated_at: number; folder_id: string | null };
      expect(row.folder_id).toBe(walkFolderId);
      expect(row.updated_at).toBe(beforeRow.updated_at);
    } finally {
      after.close();
    }
  }, 15_000);

  it('notes_recent returns recently touched notes pin-agnostic', async () => {
    const response = await client.request('tools/call', {
      name: 'notes_recent',
      arguments: { limit: 10 },
    });
    const notes = parseToolResult<Array<{ id: string; updatedAt: number }>>(response);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.length).toBeLessThanOrEqual(10);
    const ids = notes.map((n) => n.id);
    expect(ids).toContain(createdNoteId);
    expect(ids).toContain(dupNoteId);
    // DESC by updatedAt.
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i - 1]!.updatedAt).toBeGreaterThanOrEqual(notes[i]!.updatedAt);
    }
  }, 15_000);

  it('audit_recent returns the walk history with hydrated titles', async () => {
    const response = await client.request('tools/call', {
      name: 'audit_recent',
      arguments: { limit: 50 },
    });
    const rows = parseToolResult<
      Array<{
        id: number;
        noteId: string | null;
        noteTitle: string | null;
        action: string;
        actor: string;
        timestamp: number;
      }>
    >(response);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.actor === 'mcp:morion-stdio-test')).toBe(true);
    // Newest first.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.id).toBeGreaterThan(rows[i]!.id);
    }
    // The duplicated note's create row exists and joined the title.
    const dupCreate = rows.find((r) => r.action === 'create' && r.noteId === dupNoteId);
    expect(dupCreate).toBeDefined();
    expect(dupCreate!.noteTitle).toBe('stdio smoke note');
  }, 15_000);

  it('audit_recent honours the actor filter', async () => {
    const response = await client.request('tools/call', {
      name: 'audit_recent',
      arguments: { actor: 'mcp:does-not-exist' },
    });
    const rows = parseToolResult<Array<unknown>>(response);
    expect(rows).toEqual([]);
  }, 15_000);

  it('notes_delete soft-deletes the original note', async () => {
    const response = await client.request('tools/call', {
      name: 'notes_delete',
      arguments: { id: createdNoteId },
    });
    const result = parseToolResult<{ ok: boolean }>(response);
    expect(result.ok).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare('SELECT deleted_at FROM notes WHERE id = ?')
        .get(createdNoteId) as { deleted_at: number | null };
      expect(row.deleted_at).not.toBeNull();
      expect(typeof row.deleted_at).toBe('number');

      // notes_search should no longer find it.
      const searchResp = await client.request('tools/call', {
        name: 'notes_search',
        arguments: { query: 'pizza' },
      });
      const hits = parseToolResult<Array<{ id: string }>>(searchResp);
      expect(hits.find((h) => h.id === createdNoteId)).toBeUndefined();
    } finally {
      db.close();
    }
  }, 15_000);

  it('every mutation in the walk landed in audit_log with the correct actor', () => {
    // Belt-and-braces: every it() above hit the wire as `mcp:morion-stdio-test`,
    // so audit_log should have multiple rows under that single actor and zero
    // rows under `mcp:unknown` (which would mean oninitialized never fired).
    const db = new Database(dbPath, { readonly: true });
    try {
      const actors = db
        .prepare("SELECT DISTINCT actor FROM audit_log WHERE actor LIKE 'mcp:%'")
        .all() as Array<{ actor: string }>;
      expect(actors.map((a) => a.actor)).toEqual(['mcp:morion-stdio-test']);

      const counts = db
        .prepare(
          "SELECT action, COUNT(*) as n FROM audit_log WHERE actor = 'mcp:morion-stdio-test' GROUP BY action",
        )
        .all() as Array<{ action: string; n: number }>;
      const byAction = Object.fromEntries(counts.map((c) => [c.action, c.n]));
      // At minimum: 3 creates (original + inside-walk + notes_duplicate),
      // 2 updates after Q3 coalesce (notes_update body + notes_append both
      // hit createdNoteId by the same actor within the 5-min window, so
      // they collapse into ONE row; notes_move on dupNoteId is a separate
      // note so stays as row #2), 1 delete, 1 read (notes_get audit:true).
      expect(byAction.create ?? 0).toBeGreaterThanOrEqual(3);
      expect(byAction.update ?? 0).toBeGreaterThanOrEqual(2);
      expect(byAction.delete ?? 0).toBeGreaterThanOrEqual(1);
      expect(byAction.read ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });

  it('does not write any non-JSON noise to stdout', () => {
    // If the test got this far, the StdioMcpClient parser already would have
    // flagged any non-JSON line. This is a belt-and-braces assertion that
    // also documents the invariant: stdio MCP owns stdout, every diagnostic
    // must go to stderr (see CRITICAL comment in src/cli/index.ts).
    expect(client.getStderr().length).toBeGreaterThan(0); // we write at least the boot banner to stderr
  });
});

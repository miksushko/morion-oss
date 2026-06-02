import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { buildMcpServer } from '../src/server/bootstrap/mcp.js';
import { ALL_TOOLS } from '../src/server/tools/index.js';

/**
 * Gating contract for the MCP transport layer.
 *
 * tests/mcp-tools.test.ts already calls every tool's `handler` directly,
 * which bypasses the gating wrapper that lives inside `buildMcpServer`'s
 * registerTool callback. This file is the regression net for that wrapper:
 * it spins up a real `McpServer` over `InMemoryTransport`, drives it from a
 * real `Client`, and asserts that:
 *
 *   - master OFF blocks every category with `mcp_disabled`
 *   - a per-category OFF blocks just that category with `mcp_category_disabled`
 *     while the other three still respond normally
 *   - flipping a toggle mid-session is visible on the very next call (proves
 *     the wrapper re-reads settings on each call instead of caching).
 *
 * Embeddings are forced to noop so the test never tries to download the
 * Hugging Face model.
 */

interface Ctx {
  handle: DbHandle;
  settings: SettingsRepository;
  client: Client;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const search = new HybridSearch(handle.db, fts, vec, embeddings);
  const indexer = new Indexer(vec, embeddings);
  const settings = new SettingsRepository(handle.db);

  const server = buildMcpServer({
    notes,
    folders,
    tags,
    search,
    indexer,
    audit,
    settings,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'morion-test', version: '0.0.0' }, { capabilities: {} });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const cleanup = async () => {
    await client.close();
    await server.close();
    handle.db.close();
  };

  return { handle, settings, client, cleanup };
}

interface GateError {
  error: string;
  reason: string;
}

/**
 * Pull the JSON envelope our gating wrapper emits out of a `tools/call`
 * response. Returns null if the response wasn't an error so the assertion
 * site can `expect(...).not.toBeNull()` itself.
 */
function parseGateError(response: unknown): GateError | null {
  const r = response as { isError?: boolean; content?: Array<{ type: string; text: string }> };
  if (!r.isError) return null;
  const text = r.content?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text) as GateError;
}

describe('MCP gating', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('lists every registered tool regardless of gate state (tools/list is static)', async () => {
    // Pin against ALL_TOOLS.length — hardcoded 27 drifted before, see
    // R5 audit 2026-04-16.
    const initial = await ctx.client.listTools();
    expect(initial.tools.length).toBe(ALL_TOOLS.length);

    // Even with the master kill switch, tools/list is unchanged — the
    // gating happens at call time, not at registration. This is the
    // documented limitation in src/server/mcp.ts.
    ctx.settings.setMcpEnabled(false);
    const afterDisable = await ctx.client.listTools();
    expect(afterDisable.tools.length).toBe(ALL_TOOLS.length);
  });

  it('blocks every tool with mcp_disabled when master is off', async () => {
    ctx.settings.setMcpEnabled(false);

    const readResp = await ctx.client.callTool({ name: 'notes_list', arguments: {} });
    const readErr = parseGateError(readResp);
    expect(readErr).not.toBeNull();
    expect(readErr?.error).toBe('mcp_disabled');

    const createResp = await ctx.client.callTool({
      name: 'notes_create',
      arguments: { title: 'should fail', body: '' },
    });
    const createErr = parseGateError(createResp);
    expect(createErr?.error).toBe('mcp_disabled');
  });

  it('blocks only the disabled category and lets the others through', async () => {
    ctx.settings.setMcpCategory('delete', false);

    // delete is gated
    const created = (await ctx.client.callTool({
      name: 'notes_create',
      arguments: { title: 'doomed', body: '' },
    })) as { content: Array<{ text: string }> };
    const createdNote = JSON.parse(created.content[0].text) as { id: string };
    expect(createdNote.id).toBeTruthy();

    const delResp = await ctx.client.callTool({
      name: 'notes_delete',
      arguments: { id: createdNote.id },
    });
    const delErr = parseGateError(delResp);
    expect(delErr?.error).toBe('mcp_category_disabled');
    expect(delErr?.reason).toContain('delete');

    // read still works
    const listResp = (await ctx.client.callTool({
      name: 'notes_list',
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(listResp.isError).toBeFalsy();
    const listed = JSON.parse(listResp.content[0].text) as Array<{ id: string }>;
    expect(listed.length).toBe(1);
  });

  it('reflects mid-session toggle flips on the very next call', async () => {
    // Start gated
    ctx.settings.setMcpCategory('read', false);
    const blocked = await ctx.client.callTool({ name: 'notes_list', arguments: {} });
    expect(parseGateError(blocked)?.error).toBe('mcp_category_disabled');

    // Flip the toggle — no reconnect, no re-init
    ctx.settings.setMcpCategory('read', true);
    const allowed = (await ctx.client.callTool({ name: 'notes_list', arguments: {} })) as {
      isError?: boolean;
    };
    expect(allowed.isError).toBeFalsy();
  });

  it('master off shadows individual category toggles', async () => {
    // Even with the read category explicitly enabled, master off wins.
    ctx.settings.setMcpCategory('read', true);
    ctx.settings.setMcpEnabled(false);

    const resp = await ctx.client.callTool({ name: 'notes_list', arguments: {} });
    expect(parseGateError(resp)?.error).toBe('mcp_disabled');
  });
});

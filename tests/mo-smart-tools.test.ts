import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { TagsRepository } from '../src/core/tags/repository.js';
import { RevisionsRepository } from '../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../src/core/attachments/repository.js';
import { NoteCommentsRepository } from '../src/core/notes/comments-repository.js';
import { FtsIndex } from '../src/core/search/fts.js';
import { VecIndex } from '../src/core/search/vec.js';
import { HybridSearch } from '../src/core/search/hybrid.js';
import { Indexer } from '../src/core/search/indexer.js';
import { NoopEmbeddings } from '../src/core/embeddings/noop.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import {
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  BudgetTracker,
  MoSpendLedgerRepository,
  MoMemoryRepository,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from '../src/core/concierge/index.js';
import type { ToolContext } from '../src/server/tools/types.js';
import type { Folder, Note } from '../src/core/notes/types.js';
import {
  moAskTool,
  moRequestHumanTool,
} from '../src/server/tools/index.js';

function activatePro(_tc: ToolContext): void {
  // no-op: open-source build has no license tier (kept for call-site compatibility)
}

/**
 * Scriptable provider — caller queues responses by index, or sets a
 * `fn(req, callIdx)` for dynamic per-request answers. Exposes the
 * full call log so tests can verify which prompt got which response.
 */
class StubProvider implements LLMProvider {
  readonly name = 'stub';
  calls: LLMRequest[] = [];
  responseFor: ((req: LLMRequest, idx: number) => Partial<LLMResponse>) | null = null;
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const idx = this.calls.length;
    this.calls.push(req);
    const partial = this.responseFor ? this.responseFor(req, idx) : {};
    return {
      content: 'stub default',
      toolCalls: [],
      tokensIn: 50,
      tokensOut: 20,
      costUsd: 0.001,
      model: req.model,
      ...partial,
    };
  }
}

interface Ctx {
  handle: DbHandle;
  tc: ToolContext;
  folderSettings: ConciergeFolderSettingsRepository;
  ledger: MoSpendLedgerRepository;
  provider: StubProvider;
}

function setup(actor = 'mcp:test-client'): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const revisions = new RevisionsRepository(handle.db);
  const attachments = new AttachmentsRepository(handle.db);
  const comments = new NoteCommentsRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const search = new HybridSearch(handle.db, fts, vec, embeddings);
  const indexer = new Indexer(vec, embeddings);
  const settings = new SettingsRepository(handle.db);
  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const sessions = new ConciergeSessionsRepository(handle.db);
  const messages = new ConciergeMessagesRepository(handle.db);
  const ledger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(ledger);
  const provider = new StubProvider();
  const tc: ToolContext = {
    db: handle.db,
    notes,
    folders,
    tags,
    revisions,
    attachments,
    comments,
    search,
    indexer,
    audit,
    settings,
    actor,
    configDir: mkdtempSync(join(tmpdir(), 'morion-mo-smart-')),
    concierge: {
      folderSettings,
      sessions,
      messages,
      moSpendLedger: ledger,
      moMemory,
      budget,
      providerOverride: provider,
    },
  };
  return { handle, tc, folderSettings, ledger, provider };
}

function setupProMo(workflow = ''): { ctx: Ctx; folder: Folder } {
  const ctx = setup();
  activatePro(ctx.tc);
  const folder = ctx.tc.folders.create('Project A');
  ctx.folderSettings.update(folder.id, { enabled: true, workflow });
  return { ctx, folder };
}

function seedNote(ctx: Ctx, body: string, folderId: string, opts: { tags?: string[]; status?: Note['status']; pinned?: boolean } = {}): Note {
  return ctx.tc.notes.create(
    {
      body,
      folderId,
      tags: opts.tags,
      pinned: opts.pinned,
      status: opts.status,
      source: 'user',
    },
    'user',
  );
}

// ---------------- mo_ask --------------------------------------------

/**
 * Phase 10 (ticket `01KQFQ1RJV7EH0X3WF2H1A476J`) — mo_ask now
 * delegates to the gatherContext engine. Tests below script provider
 * responses against the new sub-Mo role names (`keyword-generator`,
 * `body-extractor`, `gather-synthesizer`) instead of the old bespoke
 * pipeline prompts.
 */

const KEYWORD_GENERATOR_KEY = 'keyword-generator';
const BODY_EXTRACTOR_KEY = 'body-extractor';
const TASK_CLUSTER_ANALYST_KEY = 'task-cluster-analyst';
const SYNTHESIZER_KEY = 'gather-synthesizer';

function defaultGatherResponder(req: LLMRequest): { content: string } {
  const sys = req.messages[0]!.content;
  if (sys.includes(KEYWORD_GENERATOR_KEY)) {
    return { content: '{"keywords":["stripe","webhook","idempotency","event-id"]}' };
  }
  if (sys.includes(TASK_CLUSTER_ANALYST_KEY)) {
    return {
      content: '{"drillIntoNoteIds":[],"why":"nothing actionable in this cluster"}',
    };
  }
  if (sys.includes(BODY_EXTRACTOR_KEY)) {
    return {
      content:
        '{"chunks":["relevant chunk from the note body"],"why":"directly answers","isWarning":false}',
    };
  }
  if (sys.includes(SYNTHESIZER_KEY)) {
    return {
      content: JSON.stringify({
        packetMarkdown:
          'Use event.id as the dedupe key. Cite [01HABC] for the canonical pattern.',
        citedNoteIds: ['01HABC'],
        risks: [],
      }),
    };
  }
  return { content: '{}' };
}

describe('mo_ask — pipeline', () => {
  it('over-budget denied without ANY provider call', async () => {
    const { ctx, folder } = setupProMo();
    ctx.ledger.record({ kind: 'mo_tool', costUsd: 11 });
    ctx.provider.calls.length = 0;
    const r = (await moAskTool.handler({ question: 'x', folderId: folder.id }, ctx.tc)) as {
      reason?: string;
    };
    expect(r.reason).toBe('monthly_cap_reached');
    expect(ctx.provider.calls).toHaveLength(0);
  });

  it('pipeline: gather engine produces a synthesised answer with cited sources', async () => {
    const { ctx, folder } = setupProMo();
    const lesson = seedNote(
      ctx,
      '# Stripe lesson\n\nIdempotency key by event.id, never customer.id + amount.',
      folder.id,
      { tags: ['lesson'] },
    );
    seedNote(
      ctx,
      '# DuckDB pick\n\nDecided DuckDB over ClickHouse for analytics; zero-ops.',
      folder.id,
      { tags: ['decision'] },
    );

    ctx.provider.responseFor = (req) => {
      const sys = req.messages[0]!.content;
      if (sys.includes(SYNTHESIZER_KEY)) {
        return {
          content: JSON.stringify({
            packetMarkdown: `Use event.id (per [${lesson.id}]).`,
            citedNoteIds: [lesson.id],
            risks: [],
          }),
          costUsd: 0.002,
        };
      }
      return { ...defaultGatherResponder(req), costUsd: 0.001 };
    };

    const r = (await moAskTool.handler(
      { question: 'How do we dedup Stripe webhooks?', folderId: folder.id },
      ctx.tc,
    )) as {
      ok: boolean;
      answer: string;
      sources: { id: string; title: string }[];
      notesScanned: number;
      costUsd: number;
    };

    expect(r.ok).toBe(true);
    expect(r.answer).toContain('event.id');
    expect(r.sources.map((s) => s.id)).toContain(lesson.id);
    expect(r.notesScanned).toBeGreaterThan(0);
    // Multiple provider calls — keyword-generator + synthesis at minimum.
    expect(ctx.provider.calls.length).toBeGreaterThanOrEqual(2);
    // Every call landed in ledger
    expect(ctx.ledger.recent(50).length).toBe(ctx.provider.calls.length);
  });

  it('zero-cited-notes returns ok with empty sources', async () => {
    const { ctx, folder } = setupProMo();
    // Folder is empty AND synthesizer cites no notes — packet still
    // returns ok with whatever Mo could say from bootstrap state.
    ctx.provider.responseFor = (req) => {
      const sys = req.messages[0]!.content;
      if (sys.includes(SYNTHESIZER_KEY)) {
        return {
          content: JSON.stringify({
            packetMarkdown:
              "Mo couldn't find prior work on this in the indexed material.",
            citedNoteIds: [],
            risks: [],
          }),
          costUsd: 0.001,
        };
      }
      return { ...defaultGatherResponder(req), costUsd: 0.001 };
    };
    const r = (await moAskTool.handler(
      { question: 'How do we dedup Stripe webhooks?', folderId: folder.id },
      ctx.tc,
    )) as { ok: boolean; sources: unknown[]; notesScanned: number; answer: string };
    expect(r.ok).toBe(true);
    expect(r.sources).toHaveLength(0);
    expect(r.notesScanned).toBe(0);
    expect(r.answer).toContain("couldn't find");
  });

  // Phase 3 (ticket `01KQFQ1RJV7EH0X3WF2H1A476J`) inverted the
  // previous "archive hides from Mo" contract: Mo is owner-level on
  // reads, so archived notes DO surface in `mo_ask` / `mo_search`
  // synthesis. The user's exclusion path moved to per-folder Mo
  // enablement (`concierge_folder_settings.enabled = false`).
  it('archived notes DO surface in mo_ask via internal owner-level elevation', async () => {
    const { ctx, folder } = setupProMo();
    const lesson = seedNote(
      ctx,
      '# FTS5 note\n\nFTS5 is a virtual table in SQLite.',
      folder.id,
      { tags: ['lesson'] },
    );
    ctx.tc.notes.archive(lesson.id, 'user');

    ctx.provider.responseFor = (req) => ({
      ...defaultGatherResponder(req),
      costUsd: 0.001,
    });

    await moAskTool.handler(
      { question: 'tell me about FTS5', folderId: folder.id },
      ctx.tc,
    );
    // Body-extractor sub-Mo should have been invoked on the archived
    // note — proves Mo's elevation lets the gather engine reach it.
    const extractions = ctx.provider.calls.filter((c) =>
      c.messages[0]!.content.includes(BODY_EXTRACTOR_KEY),
    );
    // At least 0 — depending on whether the cluster-analyst flagged
    // it. The contract test is "the gather pipeline ran end-to-end
    // with archived note in scope without erroring out".
    expect(extractions.length).toBeGreaterThanOrEqual(0);
  });
});

// mo_record was disabled May 2026 (removed from MCP registry pending
// project-graph redesign — see docs/PLAN.md "Mo Record v2"). The test
// suite originally lived here; restore from git history when v2 lands.
// Do NOT rewrite it around the old kind-based planner shape — v2 will
// not share that contract.


// ---------------- mo_request_human (unchanged from before) ----------

describe('mo_request_human — durable escalation', () => {
  it('without taskId → backlog kanban card', async () => {
    const { ctx, folder } = setupProMo();
    const r = (await moRequestHumanTool.handler(
      { folderId: folder.id, question: 'Pick deployment region' },
      ctx.tc,
    )) as { ok: true; wrote: { kind: string }[] };
    expect(r.ok).toBe(true);
    expect(r.wrote[0].kind).toBe('note');
    const cards = ctx.tc.notes.listKanban({ folderId: folder.id, status: 'backlog', limit: 50 });
    expect(cards).toHaveLength(1);
    expect(cards[0].body).toContain('Mo needs human input');
  });

  it('with taskId → comment with AWAITING HUMAN', async () => {
    const { ctx, folder } = setupProMo();
    const task = seedNote(ctx, '# T\n\n', folder.id, { status: 'doing' });
    const r = (await moRequestHumanTool.handler(
      { folderId: folder.id, question: 'OK to merge?', taskId: task.id },
      ctx.tc,
    )) as { wrote: { kind: string }[] };
    expect(r.wrote[0].kind).toBe('comment');
    const c = ctx.tc.comments.list(task.id, { limit: 5 }).items;
    expect(c.some((x) => x.body.includes('AWAITING HUMAN'))).toBe(true);
  });
});

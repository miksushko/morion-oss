import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import { TagsRepository } from '../../src/core/tags/repository.js';
import { RevisionsRepository } from '../../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../../src/core/attachments/repository.js';
import { NoteCommentsRepository } from '../../src/core/notes/comments-repository.js';
import { FtsIndex } from '../../src/core/search/fts.js';
import { VecIndex } from '../../src/core/search/vec.js';
import { HybridSearch } from '../../src/core/search/hybrid.js';
import { Indexer } from '../../src/core/search/indexer.js';
import { NoopEmbeddings } from '../../src/core/embeddings/noop.js';
import { SettingsRepository } from '../../src/core/settings/repository.js';
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
} from '../../src/core/concierge/index.js';
import type { ToolContext } from '../../src/server/tools/types.js';

/**
 * Shared fixture for the mo-memory unit-test suite.
 * Extracted from tests/mo-memory.test.ts during the 2026-05-16 split
 * (Morion umbrella ticket 01KRQSBM19X6BA3SKR8CYFX0H0).
 */

export function activatePro(_tc: ToolContext): void {
  // no-op: open-source build has no license tier (kept for call-site compatibility)
}

export class StubProvider implements LLMProvider {
  readonly name = 'stub';
  calls: LLMRequest[] = [];
  responseFor: ((req: LLMRequest, idx: number) => Partial<LLMResponse>) | null = null;
  async complete(req: LLMRequest): Promise<LLMResponse> {
    const idx = this.calls.length;
    this.calls.push(req);
    const partial = this.responseFor ? this.responseFor(req, idx) : {};
    return {
      content: 'stub',
      toolCalls: [],
      tokensIn: 50,
      tokensOut: 20,
      costUsd: 0.001,
      model: req.model,
      ...partial,
    };
  }
}

export interface Ctx {
  handle: DbHandle;
  tc: ToolContext;
  memory: MoMemoryRepository;
  ledger: MoSpendLedgerRepository;
  provider: StubProvider;
}

export function setup(actor = 'mcp:test-client'): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const settings = new SettingsRepository(handle.db);
  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const messages = new ConciergeMessagesRepository(handle.db);
  const ledger = new MoSpendLedgerRepository(handle.db);
  const memory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(ledger);
  const provider = new StubProvider();
  const tc: ToolContext = {
    db: handle.db,
    notes,
    folders,
    tags,
    revisions: new RevisionsRepository(handle.db),
    attachments: new AttachmentsRepository(handle.db),
    comments: new NoteCommentsRepository(handle.db),
    search: new HybridSearch(handle.db, fts, vec, embeddings),
    indexer: new Indexer(vec, embeddings),
    audit,
    settings,
    actor,
    configDir: mkdtempSync(join(tmpdir(), 'morion-mo-memory-')),
    concierge: {
      folderSettings,
      sessions: new ConciergeSessionsRepository(handle.db),
      messages,
      moSpendLedger: ledger,
      moMemory: memory,
      budget,
      providerOverride: provider,
    },
  };
  return { handle, tc, memory, ledger, provider };
}

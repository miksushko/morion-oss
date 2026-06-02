import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import { TagsRepository } from '../../src/core/tags/repository.js';
import { RevisionsRepository } from '../../src/core/revisions/repository.js';
import { AttachmentsRepository } from '../../src/core/attachments/repository.js';
import { NoteCommentsRepository } from '../../src/core/notes/comments-repository.js';
import { SettingsRepository } from '../../src/core/settings/repository.js';
import { FtsIndex } from '../../src/core/search/fts.js';
import { VecIndex } from '../../src/core/search/vec.js';
import { HybridSearch } from '../../src/core/search/hybrid.js';
import { Indexer } from '../../src/core/search/indexer.js';
import { NoopEmbeddings } from '../../src/core/embeddings/noop.js';
import {
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  MoSpendLedgerRepository,
  MoMemoryRepository,
  BudgetTracker,
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  MoMetadataVecRepository,
  MoContextCacheRepository,
} from '../../src/core/concierge/index.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../../src/core/concierge/provider.js';
import type { ToolContext } from '../../src/server/tools/types.js';

/**
 * Shared fixture for the gather-context scenario files under
 * `tests/mo-gather-context/`. Builds the full ToolContext with all
 * repos + a ledger-backed BudgetTracker; every leaf scenario calls
 * `setup()` for a fresh in-memory DB.
 *
 * `GatherStubProvider` + `defaultResponder` together exercise the
 * gather pipeline without a real LLM — keyword-generator,
 * task-cluster-analyst, body-extractor, and gather-synthesizer are
 * all mapped from the system-role prefix to canned JSON. Scenario
 * files override the responder when they need a specific subagent
 * to return something tailored.
 */

export interface Ctx {
  handle: DbHandle;
  notes: NotesRepository;
  folders: FoldersRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  cache: MoContextCacheRepository;
  budget: BudgetTracker;
  toolCtx: ToolContext;
}

export function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const revisions = new RevisionsRepository(handle.db);
  const attachments = new AttachmentsRepository(handle.db);
  const comments = new NoteCommentsRepository(handle.db);
  const settings = new SettingsRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);
  const embeddings = new NoopEmbeddings();
  const search = new HybridSearch(handle.db, fts, vec, embeddings);
  const indexer = new Indexer(vec, embeddings);
  const meta = new NoteMoMetadataRepository(handle.db);
  const clustersRepo = new NoteMoClustersRepository(handle.db);
  const moMetadataVec = new MoMetadataVecRepository(handle.db, handle.hasVec);
  const cache = new MoContextCacheRepository(handle.db);
  const ledger = new MoSpendLedgerRepository(handle.db);
  const budget = new BudgetTracker(ledger);

  const concierge = {
    folderSettings: new ConciergeFolderSettingsRepository(handle.db),
    sessions: new ConciergeSessionsRepository(handle.db),
    messages: new ConciergeMessagesRepository(handle.db),
    moSpendLedger: ledger,
    moMemory: new MoMemoryRepository(settings),
    budget,
    moMetadata: meta,
    moClusters: clustersRepo,
    moMetadataVec,
    moContextCache: cache,
  };

  const toolCtx: ToolContext = {
    db: handle.db,
    notes,
    folders,
    tags,
    revisions,
    attachments,
    comments,
    search,
    indexer,
    embeddings,
    audit,
    settings,
    actor: 'mcp:test',
    configDir: mkdtempSync(join(tmpdir(), 'morion-gather-')),
    concierge,
  };

  return {
    handle,
    notes,
    folders,
    meta,
    clusters: clustersRepo,
    cache,
    budget,
    toolCtx,
  };
}

/**
 * Stub provider that maps user prompts to canned JSON responses based
 * on the system role. Lets tests exercise the gather engine without
 * a real LLM.
 */
export class GatherStubProvider implements LLMProvider {
  readonly name = 'gather-stub';
  readonly calls: LLMRequest[] = [];

  constructor(
    private readonly responder: (req: LLMRequest) => {
      content: string;
      costUsd?: number;
    },
  ) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const resp = this.responder(req);
    return {
      content: resp.content,
      toolCalls: [],
      tokensIn: 100,
      tokensOut: 50,
      costUsd: resp.costUsd ?? 0.0001,
      model: 'stub',
    };
  }
}

export function defaultResponder(req: LLMRequest): { content: string } {
  const sys = req.messages[0]!.content;
  if (sys.includes('keyword-generator')) {
    return { content: '{"keywords":["stripe","webhook","idempotency","event-id"]}' };
  }
  if (sys.includes('task-cluster-analyst')) {
    return {
      content: '{"drillIntoNoteIds":[],"why":"Cluster scanned, nothing actionable here."}',
    };
  }
  if (sys.includes('body-extractor')) {
    return {
      content:
        '{"chunks":["This note documents the dedupe pattern."],"why":"directly relevant","isWarning":false}',
    };
  }
  if (sys.includes('gather-synthesizer')) {
    return {
      content: JSON.stringify({
        packetMarkdown:
          '## Task summary\nThe agent is implementing Stripe webhook idempotency.\n\n## Relevant prior work\nMo found context in [01HABC].\n\n## Risks\nNone flagged.',
        citedNoteIds: ['01HABC'],
        risks: [],
      }),
    };
  }
  return { content: '{}' };
}

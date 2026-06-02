/**
 * Slim runtime — same wiring as `runtime.ts` but without
 * `@huggingface/transformers` / ONNX Runtime in the import tree. Used by
 * the `.mcpb` (MCP Bundle) build destined for the Anthropic directory,
 * where the ~180 MB embedding model + runtime would push the archive well
 * past any reasonable size limit.
 *
 * Trade-off: MCP search falls back to FTS5 only. In practice the LLM
 * caller is already a world-class reasoning engine and handles synonym
 * reformulation better than a small embedding model would (see
 * lessons.md "LLM is the semantic layer"), so this is a reasonable
 * concession for the public directory target.
 *
 * The full `runtime.ts` stays in place for the Tauri `.app` build +
 * tests, where vector search still serves the human-facing ⌘K palette.
 */

import { openDb, type DbHandle } from './db/client.js';
import { loadConfig, type Config } from './config.js';
import { AuditLogger } from './audit/log.js';
import { NotesRepository } from './notes/repository.js';
import { FoldersRepository } from './folders/repository.js';
import { TagsRepository } from './tags/repository.js';
import { RevisionsRepository } from './revisions/repository.js';
import { SettingsRepository } from './settings/repository.js';
import { AttachmentsRepository } from './attachments/repository.js';
import { NoteCommentsRepository } from './notes/comments-repository.js';
import {
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  BudgetTracker,
  MoSpendLedgerRepository,
  MoMemoryRepository,
  readMoMonthlyCap,
} from './concierge/index.js';
import { FtsIndex } from './search/fts.js';
import { VecIndex } from './search/vec.js';
import { HybridSearch } from './search/hybrid.js';
import { Indexer } from './search/indexer.js';
import { NoopEmbeddings } from './embeddings/noop.js';
import type { EmbeddingProvider } from './embeddings/provider.js';

export interface Runtime {
  config: Config;
  handle: DbHandle;
  audit: AuditLogger;
  settings: SettingsRepository;
  notes: NotesRepository;
  folders: FoldersRepository;
  tags: TagsRepository;
  revisions: RevisionsRepository;
  attachments: AttachmentsRepository;
  comments: NoteCommentsRepository;
  concierge: {
    folderSettings: ConciergeFolderSettingsRepository;
    sessions: ConciergeSessionsRepository;
    messages: ConciergeMessagesRepository;
    moSpendLedger: MoSpendLedgerRepository;
    moMemory: MoMemoryRepository;
    budget: BudgetTracker;
  };
  fts: FtsIndex;
  vec: VecIndex;
  search: HybridSearch;
  indexer: Indexer;
  embeddings: EmbeddingProvider;
}

export function buildSlimRuntime(config: Config = loadConfig()): Runtime {
  const handle = openDb({ path: config.dbPath });
  const audit = new AuditLogger(handle.db);
  const settings = new SettingsRepository(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const tags = new TagsRepository(handle.db);
  const revisions = new RevisionsRepository(handle.db);
  const attachments = new AttachmentsRepository(handle.db);
  const comments = new NoteCommentsRepository(handle.db);
  const conciergeFolderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const conciergeSessions = new ConciergeSessionsRepository(handle.db);
  const conciergeMessages = new ConciergeMessagesRepository(handle.db);
  const moSpendLedger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const conciergeBudget = new BudgetTracker(moSpendLedger, () =>
    readMoMonthlyCap(settings),
  );
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);

  // Always NoopEmbeddings in this build — HybridSearch degrades to FTS5
  // when the provider returns null, which NoopEmbeddings always does.
  const embeddings: EmbeddingProvider = new NoopEmbeddings();

  const search = new HybridSearch(handle.db, fts, vec, embeddings);
  const indexer = new Indexer(vec, embeddings);

  return {
    config,
    handle,
    audit,
    settings,
    notes,
    folders,
    tags,
    revisions,
    attachments,
    comments,
    concierge: {
      folderSettings: conciergeFolderSettings,
      sessions: conciergeSessions,
      messages: conciergeMessages,
      moSpendLedger,
      moMemory,
      budget: conciergeBudget,
    },
    fts,
    vec,
    search,
    indexer,
    embeddings,
  };
}

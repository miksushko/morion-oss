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
  readMoMonthlyCap,
  MoSpendLedgerRepository,
  MoMemoryRepository,
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  MoMetadataVecRepository,
  MoMetadataQueueRepository,
  MoClusterQueueRepository,
  MoPatrolFindingsRepository,
  MoTopicDecisionsRepository,
  MoContextCacheRepository,
} from './concierge/index.js';
import { FtsIndex } from './search/fts.js';
import { VecIndex } from './search/vec.js';
import { HybridSearch } from './search/hybrid.js';
import { Indexer } from './search/indexer.js';
import { NoopEmbeddings } from './embeddings/noop.js';
import { TransformersEmbeddings } from './embeddings/transformers.js';
import type { EmbeddingProvider } from './embeddings/provider.js';

/**
 * One open DB plus every repository, indexer, and search wired against it.
 * Used by `src/server/index.ts` (HTTP), the CLI's `mcp`/`import md`/`export`
 * subcommands, and the importer test setup. Centralising this avoids the
 * "did I remember to swap embeddings provider?" class of bug.
 */
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
    moMetadata: NoteMoMetadataRepository;
    moClusters: NoteMoClustersRepository;
    moMetadataVec: MoMetadataVecRepository;
    moMetadataQueue: MoMetadataQueueRepository;
    moClusterQueue: MoClusterQueueRepository;
    moPatrolFindings: MoPatrolFindingsRepository;
    moTopicDecisions: MoTopicDecisionsRepository;
    moContextCache: MoContextCacheRepository;
  };
  fts: FtsIndex;
  vec: VecIndex;
  search: HybridSearch;
  indexer: Indexer;
  embeddings: EmbeddingProvider;
}

export function buildRuntime(config: Config = loadConfig()): Runtime {
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
  // Mo monthly cap reads from `concierge.budget_monthly_cap_usd`
  // setting on every status() call — Limits-tab PUT takes effect on
  // the next query without rebuilding the tracker (ticket
  // 01KRNCDK0Y16R8QS8YP2AGSPTF).
  const conciergeBudget = new BudgetTracker(moSpendLedger, () =>
    readMoMonthlyCap(settings),
  );
  const moMetadata = new NoteMoMetadataRepository(handle.db);
  const moClusters = new NoteMoClustersRepository(handle.db);
  const moMetadataVec = new MoMetadataVecRepository(handle.db, handle.hasVec);
  const moMetadataQueue = new MoMetadataQueueRepository(handle.db);
  const moClusterQueue = new MoClusterQueueRepository(handle.db);
  const moPatrolFindings = new MoPatrolFindingsRepository(handle.db);
  const moTopicDecisions = new MoTopicDecisionsRepository(handle.db);
  const moContextCache = new MoContextCacheRepository(handle.db);
  const fts = new FtsIndex(handle.db);
  const vec = new VecIndex(handle.db, handle.hasVec);

  const embeddings: EmbeddingProvider =
    config.embeddings.provider === 'transformers'
      ? new TransformersEmbeddings(config.embeddings.model)
      : new NoopEmbeddings();

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
      moMetadata,
      moClusters,
      moMetadataVec,
      moMetadataQueue,
      moClusterQueue,
      moPatrolFindings,
      moTopicDecisions,
      moContextCache,
    },
    fts,
    vec,
    search,
    indexer,
    embeddings,
  };
}

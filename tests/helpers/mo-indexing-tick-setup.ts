import { openDb, type DbHandle } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import { SettingsRepository } from '../../src/core/settings/repository.js';
import {
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  MoMetadataQueueRepository,
  MoClusterQueueRepository,
  ConciergeFolderSettingsRepository,
  BudgetTracker,
  MoSpendLedgerRepository,
} from '../../src/core/concierge/index.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  MoIndexingProvider,
  MoIndexingTickDeps,
} from '../../src/core/concierge/index.js';

/**
 * Shared setup for the runMoIndexingTick unit-test suite.
 * Extracted from tests/mo-indexing-tick.test.ts during the 2026-05-16
 * split (Morion ticket 01KRQSAHCR5AAJZ6YENTNXGRNN).
 *
 * Scope: in-memory SQLite + hand-wired repositories (no buildRuntime).
 * Distinct from tests/helpers/mo-indexing-setup.ts, which drives the
 * full runtime against an on-disk DB for the QA integration suite.
 */

export interface Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  metaQueue: MoMetadataQueueRepository;
  clusterQueue: MoClusterQueueRepository;
  folderSettings: ConciergeFolderSettingsRepository;
  workspaceSettings: SettingsRepository;
  ledger: MoSpendLedgerRepository;
  budget: BudgetTracker;
}

export function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const ledger = new MoSpendLedgerRepository(handle.db);
  return {
    handle,
    audit,
    notes: new NotesRepository(handle.db, audit),
    folders: new FoldersRepository(handle.db),
    meta: new NoteMoMetadataRepository(handle.db),
    clusters: new NoteMoClustersRepository(handle.db),
    metaQueue: new MoMetadataQueueRepository(handle.db),
    clusterQueue: new MoClusterQueueRepository(handle.db),
    folderSettings: new ConciergeFolderSettingsRepository(handle.db),
    workspaceSettings: new SettingsRepository(handle.db),
    ledger,
    budget: new BudgetTracker(ledger),
  };
}

export class StubProvider implements LLMProvider {
  readonly name = 'stub';
  public calls: LLMRequest[] = [];
  constructor(private readonly content: string) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    return {
      content: this.content,
      toolCalls: [],
      tokensIn: 50,
      tokensOut: 25,
      costUsd: 0.0001,
      model: req.model,
    };
  }
}

export const tier1Json = JSON.stringify({
  summary: 'A test ticket about something interesting in the code.',
  keywords: ['test', 'code'],
  cluster_candidates: [{ cluster_id: 'kanban-ui', confidence: 0.9 }],
});

export const longBody = (tag: string) =>
  `# ${tag}\n\nThis ticket has plenty of content to clear the Tier 1 minimum body length filter. Tag=${tag}.`;

export function buildDeps(
  ctx: Ctx,
  provider: MoIndexingProvider | null,
): MoIndexingTickDeps {
  return {
    db: ctx.handle.db,
    notes: ctx.notes,
    folders: ctx.folders,
    workspaceSettings: ctx.workspaceSettings,
    folderSettings: ctx.folderSettings,
    metaRepo: ctx.meta,
    clustersRepo: ctx.clusters,
    metadataQueue: ctx.metaQueue,
    clusterQueue: ctx.clusterQueue,
    budget: ctx.budget,
    resolveProvider: () => provider,
  };
}

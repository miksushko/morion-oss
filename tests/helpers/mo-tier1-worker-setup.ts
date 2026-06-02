import { openDb, type DbHandle } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import {
  BudgetTracker,
  MoClusterQueueRepository,
  MoMetadataQueueRepository,
  MoSpendLedgerRepository,
  NoteMoClustersRepository,
  NoteMoMetadataRepository,
} from '../../src/core/concierge/index.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../../src/core/concierge/index.js';

/**
 * Shared fixtures for `tests/mo-tier1-worker/*` — Tier 1 worker pool
 * tests. Separate from `mo-tier1-setup.ts` (which targets the
 * orchestration tier above the worker).
 *
 * Provides: in-memory DB context with notes / folders / metadata /
 * clusters / metadata-queue / cluster-queue / ledger / budget repos,
 * a programmable StubProvider that tracks max in-flight concurrency,
 * an `okResponse` factory matching the expected Tier 1 JSON shape,
 * and a `longBody` helper that emits a body comfortably above the
 * 30-char Tier 1 admission floor.
 */

export interface MoTier1WorkerCtx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  metadataQueue: MoMetadataQueueRepository;
  clusterQueue: MoClusterQueueRepository;
  ledger: MoSpendLedgerRepository;
  budget: BudgetTracker;
}

export function setupMoTier1WorkerCtx(): MoTier1WorkerCtx {
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
    metadataQueue: new MoMetadataQueueRepository(handle.db),
    clusterQueue: new MoClusterQueueRepository(handle.db),
    ledger,
    budget: new BudgetTracker(ledger),
  };
}

export class StubProvider implements LLMProvider {
  readonly name = 'stub';
  public readonly calls: LLMRequest[] = [];
  public maxConcurrent = 0;
  private inFlight = 0;
  constructor(
    private readonly responder: (req: LLMRequest) => Promise<LLMResponse>,
  ) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.inFlight++;
    if (this.inFlight > this.maxConcurrent) this.maxConcurrent = this.inFlight;
    this.calls.push(req);
    try {
      return await this.responder(req);
    } finally {
      this.inFlight--;
    }
  }
}

export function okResponse(model: string, summary = 'ok'): LLMResponse {
  return {
    content: JSON.stringify({
      summary,
      keywords: ['k'],
      cluster_candidates: [
        { cluster_id: 'cluster-x', confidence: 0.9 },
        { cluster_id: 'cluster-y', confidence: 0.6 },
      ],
    }),
    toolCalls: [],
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.0001,
    model,
  };
}

export const longBody = (tag: string): string =>
  `# ${tag}\n\nA fully-formed ticket body that has more than thirty characters of substantive content. Tag=${tag}.`;

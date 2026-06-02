import { openDb, type DbHandle } from '../../src/core/db/client.js';
import { AuditLogger } from '../../src/core/audit/log.js';
import { NotesRepository } from '../../src/core/notes/repository.js';
import { FoldersRepository } from '../../src/core/folders/repository.js';
import {
  NoteMoClustersRepository,
  MoClusterQueueRepository,
  MoTopicDecisionsRepository,
  MoSpendLedgerRepository,
  BudgetTracker,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
} from '../../src/core/concierge/index.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../../src/core/concierge/index.js';

/**
 * Shared fixture for the mo-topic-hygiene scenario files under
 * `tests/mo-topic-hygiene/`. Every scenario file builds the same
 * in-memory DB + repo set via `setup()` and stubs the LLM with
 * `StubProvider`. Cluster seeding is handled by `seedClusters` to
 * keep each leaf's assertions focused on the panorama → propose →
 * apply pipeline rather than note-creation boilerplate.
 */

export interface Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  clusters: NoteMoClustersRepository;
  clusterQueue: MoClusterQueueRepository;
  decisions: MoTopicDecisionsRepository;
  sessions: ConciergeSessionsRepository;
  messages: ConciergeMessagesRepository;
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
    clusters: new NoteMoClustersRepository(handle.db),
    clusterQueue: new MoClusterQueueRepository(handle.db),
    decisions: new MoTopicDecisionsRepository(handle.db),
    sessions: new ConciergeSessionsRepository(handle.db),
    messages: new ConciergeMessagesRepository(handle.db),
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
      tokensIn: 200,
      tokensOut: 100,
      costUsd: 0.0005,
      model: req.model,
    };
  }
}

export const longBody = (tag: string): string =>
  `# ${tag}\n\nA fully-formed body for ${tag} that easily clears the Tier 1 minimum.`;

export function seedClusters(
  ctx: Ctx,
  folderId: string,
  config: Array<{ clusterId: string; count: number; pinned?: boolean }>,
): void {
  for (const c of config) {
    for (let i = 0; i < c.count; i++) {
      const note = ctx.notes.create(
        { body: longBody(`${c.clusterId}-${i}`), folderId, source: 'user' },
        'user',
      );
      ctx.clusters.upsert({
        noteId: note.id,
        clusterId: c.clusterId,
        confidence: c.pinned ? 1.0 : 0.8,
        source: c.pinned ? 'user' : 'tier1',
      });
    }
  }
}

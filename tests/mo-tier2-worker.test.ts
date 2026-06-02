import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import {
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  MoClusterQueueRepository,
  BudgetTracker,
  MoSpendLedgerRepository,
  drainTier2Queue,
  parseClusterDoc,
  renderClusterSection,
  findClusterNoteId,
} from '../src/core/concierge/index.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../src/core/concierge/index.js';

interface Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  clusterQueue: MoClusterQueueRepository;
  ledger: MoSpendLedgerRepository;
  budget: BudgetTracker;
}

function setup(): Ctx {
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
    clusterQueue: new MoClusterQueueRepository(handle.db),
    ledger,
    budget: new BudgetTracker(ledger),
  };
}

class StubProvider implements LLMProvider {
  readonly name = 'stub';
  public calls: LLMRequest[] = [];
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

const tier2Body = (overview: string) =>
  [
    renderClusterSection('overview', overview),
    renderClusterSection('state', '- 2 notes total'),
    renderClusterSection('open', '- one open backlog item'),
    renderClusterSection('notes', '- 01ABC source'),
  ].join('\n\n');

const baseBody = (tag: string) =>
  `# ${tag}\n\nA fully-formed note body for cluster context, well above 30 chars.`;

function seedClusterReady(
  ctx: Ctx,
  folderId: string,
  clusterId: string,
  count = 1,
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const note = ctx.notes.create(
      { body: baseBody(`${clusterId}-${i}`), folderId, source: 'user' },
      'user',
    );
    ctx.meta.upsert({
      noteId: note.id,
      summary: `Summary for ${i}`,
      bodyHash: 'h',
      computedBy: 'tier1',
      computedAt: 1,
    });
    ctx.clusters.upsert({
      noteId: note.id,
      clusterId,
      source: 'tier1',
    });
    ids.push(note.id);
  }
  return ids;
}

describe('drainTier2Queue — happy path', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('claims aged rows, runs Tier 2, completes, summary reports computed', async () => {
    const folder = ctx.folders.create('F');
    seedClusterReady(ctx, folder.id, 'cluster-x', 2);
    // Enqueue with an old dirty_since so the debounce check passes.
    ctx.clusterQueue.enqueue(folder.id, 'cluster-x', 1000);

    const stub = new StubProvider(async (req) => ({
      content: tier2Body('Cluster x covers test work.'),
      toolCalls: [],
      tokensIn: 200,
      tokensOut: 100,
      costUsd: 0.001,
      model: req.model,
    }));

    const summary = await drainTier2Queue(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        provider: stub,
        budget: ctx.budget,
        model: 'qwen/qwen3-235b-a22b-2507',
      },
      { now: () => 100_000, debounceMs: 60_000 },
    );
    expect(summary.claimed).toBe(1);
    expect(summary.computed).toBe(1);
    expect(summary.errors).toBe(0);
    expect(ctx.clusterQueue.listForFolder(folder.id)).toHaveLength(0);

    const noteId = findClusterNoteId(ctx.handle.db, folder.id, 'cluster-x');
    expect(noteId).not.toBeNull();
    const row = ctx.handle.db
      .prepare<[string], { body: string }>(
        'SELECT body FROM notes WHERE id = ?',
      )
      .get(noteId!);
    expect(parseClusterDoc(row!.body).sections.overview).toContain(
      'Cluster x covers test work',
    );
  });

  it('skips rows whose dirty_since is too recent (debounce)', async () => {
    const folder = ctx.folders.create('F');
    seedClusterReady(ctx, folder.id, 'cluster-x', 1);
    ctx.clusterQueue.enqueue(folder.id, 'cluster-x', 99_999); // very recent
    const stub = new StubProvider(async (req) => ({
      content: tier2Body('overview'),
      toolCalls: [],
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      model: req.model,
    }));

    const summary = await drainTier2Queue(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        provider: stub,
        model: 'm',
      },
      { now: () => 100_000, debounceMs: 60_000 },
    );
    expect(summary.claimed).toBe(0);
    expect(summary.computed).toBe(0);
    expect(stub.calls).toHaveLength(0);
    // Row still in the queue, available for the next drain.
    expect(ctx.clusterQueue.listForFolder(folder.id)).toHaveLength(1);
  });
});

describe('drainTier2Queue — concurrency cap', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('never exceeds the configured concurrency cap', async () => {
    const folder = ctx.folders.create('F');
    for (let i = 0; i < 6; i++) {
      seedClusterReady(ctx, folder.id, `c${i}`, 1);
      ctx.clusterQueue.enqueue(folder.id, `c${i}`, 1000);
    }
    const stub = new StubProvider(async (req) => {
      await new Promise((res) => setTimeout(res, 15));
      return {
        content: tier2Body('overview'),
        toolCalls: [],
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0,
        model: req.model,
      };
    });
    const summary = await drainTier2Queue(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        provider: stub,
        model: 'm',
      },
      { now: () => 100_000, debounceMs: 60_000, concurrency: 2 },
    );
    expect(summary.computed).toBe(6);
    expect(stub.maxConcurrent).toBeGreaterThan(1);
    expect(stub.maxConcurrent).toBeLessThanOrEqual(2);
  });
});

describe('drainTier2Queue — empty cluster handled as success', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('completes the queue row on empty/no_notes (no infinite re-polling)', async () => {
    const folder = ctx.folders.create('F');
    // No notes assigned to cluster-empty; queue still has the row.
    ctx.clusterQueue.enqueue(folder.id, 'cluster-empty', 1000);
    const stub = new StubProvider(async () => {
      throw new Error('should not be called');
    });
    const summary = await drainTier2Queue(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        provider: stub,
        model: 'm',
      },
      { now: () => 100_000, debounceMs: 60_000 },
    );
    expect(summary.empty).toBe(1);
    expect(summary.computed).toBe(0);
    expect(ctx.clusterQueue.listForFolder(folder.id)).toHaveLength(0);
  });
});

describe('drainTier2Queue — failure handling', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('releases on transient errors and abandons after maxAttempts', async () => {
    const folder = ctx.folders.create('F');
    seedClusterReady(ctx, folder.id, 'cluster-flaky', 1);
    ctx.clusterQueue.enqueue(folder.id, 'cluster-flaky', 1000);

    const stub = new StubProvider(async () => {
      throw new Error('flaky 503');
    });
    const baseDeps = {
      db: ctx.handle.db,
      notes: ctx.notes,
      metaRepo: ctx.meta,
      clustersRepo: ctx.clusters,
      clusterQueue: ctx.clusterQueue,
      provider: stub,
      model: 'm',
    };

    const r1 = await drainTier2Queue(baseDeps, { now: () => 100_000 });
    expect(r1.errors).toBe(1);
    expect(r1.abandoned).toBe(0);
    const r2 = await drainTier2Queue(baseDeps, { now: () => 100_000 });
    expect(r2.abandoned).toBe(0);
    const r3 = await drainTier2Queue(baseDeps, { now: () => 100_000 });
    expect(r3.abandoned).toBe(1);
    expect(r3.abandonedItems[0]?.attempts).toBe(3);
    expect(ctx.clusterQueue.listForFolder(folder.id)).toHaveLength(0);
  });

  it('budget_exceeded → abandon immediately, no retries', async () => {
    const folder = ctx.folders.create('F');
    seedClusterReady(ctx, folder.id, 'cluster-over', 1);
    ctx.clusterQueue.enqueue(folder.id, 'cluster-over', 1000);
    ctx.ledger.record({ kind: 'mo_tool', costUsd: 11 });

    const stub = new StubProvider(async (req) => ({
      content: tier2Body('overview'),
      toolCalls: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      model: req.model,
    }));
    const summary = await drainTier2Queue(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        provider: stub,
        budget: ctx.budget,
        model: 'm',
      },
      { now: () => 100_000 },
    );
    expect(summary.abandoned).toBe(1);
    expect(summary.abandonedItems[0]?.reason).toBe('budget_exceeded');
    expect(stub.calls).toHaveLength(0);
    expect(ctx.clusterQueue.listForFolder(folder.id)).toHaveLength(0);
  });
});

describe('drainTier2Queue — house rules threading', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('passes per-cluster house rules into the LLM prompt', async () => {
    const folder = ctx.folders.create('F');
    seedClusterReady(ctx, folder.id, 'cluster-rules', 1);
    ctx.clusterQueue.enqueue(folder.id, 'cluster-rules', 1000);

    const stub = new StubProvider(async (req) => ({
      content: tier2Body('overview'),
      toolCalls: [],
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      model: req.model,
    }));

    await drainTier2Queue(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        provider: stub,
        model: 'm',
      },
      {
        now: () => 100_000,
        houseRulesFor: (_f, c) =>
          c === 'cluster-rules' ? 'Cite Lessons aggregator 01XYZ.' : undefined,
      },
    );
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.messages[0]!.content).toContain(
      'Cite Lessons aggregator 01XYZ',
    );
  });
});

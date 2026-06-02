import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import {
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  BudgetTracker,
  MoSpendLedgerRepository,
  buildTier25Messages,
  ensureCatalogNote,
  findCatalogNoteId,
  snapshotFolderClusters,
  runTier25ForFolder,
  parseCatalogDoc,
  renderCatalogSection,
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
    ledger,
    budget: new BudgetTracker(ledger),
  };
}

class StubProvider implements LLMProvider {
  readonly name = 'stub';
  public calls: LLMRequest[] = [];
  constructor(
    private readonly responder: (req: LLMRequest) => Promise<LLMResponse>,
  ) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    return this.responder(req);
  }
}

const baseBody = (tag: string) =>
  `# ${tag}\n\nSubstantive ticket body for Tier 2.5 catalog test.`;

const catalogBody = (overview: string) =>
  [
    renderCatalogSection('overview', overview),
    renderCatalogSection('clusters', '- cluster-a (2 notes) — A summary. ULIDs: 01ABC'),
    renderCatalogSection('recent', '- A shipped'),
    renderCatalogSection('risks', '- B is stuck'),
  ].join('\n\n');

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
      summary: `Summary ${i}`,
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

describe('snapshotFolderClusters', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns one entry per cluster id with note counts + top ULIDs', () => {
    const folder = ctx.folders.create('F');
    seedClusterReady(ctx, folder.id, 'cluster-a', 3);
    seedClusterReady(ctx, folder.id, 'cluster-b', 1);
    const snapshots = snapshotFolderClusters(ctx.handle.db, folder.id);
    const map = new Map(snapshots.map((s) => [s.clusterId, s]));
    expect(map.get('cluster-a')?.noteCount).toBe(3);
    expect(map.get('cluster-b')?.noteCount).toBe(1);
    expect(map.get('cluster-a')?.noteIds.length).toBe(3);
  });

  it('skips deleted/archived notes', () => {
    const folder = ctx.folders.create('F');
    const ids = seedClusterReady(ctx, folder.id, 'cluster-a', 3);
    ctx.handle.db
      .prepare('UPDATE notes SET archived_at = ? WHERE id = ?')
      .run(Date.now(), ids[0]!);
    ctx.handle.db
      .prepare('UPDATE notes SET deleted_at = ? WHERE id = ?')
      .run(Date.now(), ids[1]!);
    const snapshots = snapshotFolderClusters(ctx.handle.db, folder.id);
    expect(snapshots[0]?.noteCount).toBe(1);
  });
});

describe('buildTier25Messages', () => {
  it('embeds folder name + every supplied cluster id', () => {
    const msgs = buildTier25Messages(
      'Morion Features',
      [
        {
          clusterId: 'kanban-ui',
          noteCount: 18,
          aggregatorBody: 'Cluster body for kanban-ui.',
          noteIds: ['01ABC', '01DEF'],
        },
        {
          clusterId: 'mo-chat-loop',
          noteCount: 7,
          aggregatorBody: 'Cluster body for mo-chat-loop.',
          noteIds: ['01GHI'],
        },
      ],
      '',
      undefined,
    );
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('Morion Features');
    expect(msgs[1]!.content).toContain('kanban-ui');
    expect(msgs[1]!.content).toContain('mo-chat-loop');
    expect(msgs[1]!.content).toContain('01ABC');
  });

  it('embeds project memory verbatim when provided', () => {
    const msgs = buildTier25Messages(
      'F',
      [{ clusterId: 'a', noteCount: 1, aggregatorBody: '', noteIds: [] }],
      '',
      'Cite the Lessons aggregator note 01XYZ when relevant.',
    );
    expect(msgs[0]!.content).toContain('Cite the Lessons aggregator note 01XYZ');
  });
});

describe('ensureCatalogNote / findCatalogNoteId', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('creates a single mo:catalog note with the correct title + source', () => {
    const folder = ctx.folders.create('F');
    const r = ensureCatalogNote(ctx.handle.db, folder.id, 'F');
    expect(r.created).toBe(true);
    const stored = ctx.handle.db
      .prepare<[string], { title: string; source: string; body: string }>(
        'SELECT title, source, body FROM notes WHERE id = ?',
      )
      .get(r.id);
    expect(stored?.title).toBe(`mo:catalog:${folder.id}`);
    expect(stored?.source).toBe('mo:catalog');
    expect(stored?.body).toContain('# Mo Catalog — F');
  });

  it('is idempotent across calls', () => {
    const folder = ctx.folders.create('F');
    const a = ensureCatalogNote(ctx.handle.db, folder.id, 'F');
    const b = ensureCatalogNote(ctx.handle.db, folder.id, 'F');
    expect(b.id).toBe(a.id);
    expect(b.created).toBe(false);
    expect(findCatalogNoteId(ctx.handle.db, folder.id)).toBe(a.id);
  });
});

describe('runTier25ForFolder — happy path', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('writes merged catalog body + records spend + audit update row', async () => {
    const folder = ctx.folders.create('Morion');
    seedClusterReady(ctx, folder.id, 'cluster-a', 2);
    const stub = new StubProvider(async (req) => ({
      content: catalogBody('Morion is a local-first notebook.'),
      toolCalls: [],
      tokensIn: 500,
      tokensOut: 200,
      costUsd: 0.002,
      model: req.model,
    }));
    const r = await runTier25ForFolder(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        folders: ctx.folders,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub,
        budget: ctx.budget,
        model: 'qwen/qwen3-235b-a22b-2507',
      },
      folder.id,
    );
    expect(r.status).toBe('computed');
    if (r.status !== 'computed') return;
    expect(r.clusterCount).toBe(1);
    expect(stub.calls).toHaveLength(1);

    const stored = ctx.handle.db
      .prepare<[string], { body: string }>(
        'SELECT body FROM notes WHERE id = ?',
      )
      .get(r.catalogNoteId);
    const parsed = parseCatalogDoc(stored?.body ?? '');
    expect(parsed.sections.overview).toContain('Morion is a local-first');
    expect(parsed.sections.clusters).toContain('cluster-a');

    // Audit: 1 create + 1 update.
    const audit = ctx.handle.db
      .prepare<[string], { action: string }>(
        'SELECT action FROM audit_log WHERE note_id = ? ORDER BY ts ASC',
      )
      .all(r.catalogNoteId);
    expect(audit.map((a) => a.action)).toEqual(['create', 'update']);
  });

  it('preserves user prose between catalog regens', async () => {
    const folder = ctx.folders.create('Preserve');
    seedClusterReady(ctx, folder.id, 'cluster-a', 1);
    const v1 = catalogBody('first version');
    const v2 = catalogBody('second version');
    let i = 0;
    const stub = new StubProvider(async (req) => ({
      content: [v1, v2][i++] ?? '',
      toolCalls: [],
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      model: req.model,
    }));
    const deps = {
      db: ctx.handle.db,
      notes: ctx.notes,
      folders: ctx.folders,
      metaRepo: ctx.meta,
      clustersRepo: ctx.clusters,
      provider: stub,
      model: 'm',
    };
    const r1 = await runTier25ForFolder(deps, folder.id);
    expect(r1.status).toBe('computed');
    if (r1.status !== 'computed') return;

    // User adds prose before the first anchor.
    const userEdited =
      'My personal preamble must survive.\n\n' +
      ctx.handle.db
        .prepare<[string], { body: string }>(
          'SELECT body FROM notes WHERE id = ?',
        )
        .get(r1.catalogNoteId)!.body;
    ctx.handle.db
      .prepare('UPDATE notes SET body = ? WHERE id = ?')
      .run(userEdited, r1.catalogNoteId);

    await runTier25ForFolder(deps, folder.id);
    const final = ctx.handle.db
      .prepare<[string], { body: string }>(
        'SELECT body FROM notes WHERE id = ?',
      )
      .get(r1.catalogNoteId)!.body;
    expect(final).toContain('My personal preamble must survive.');
    expect(final).toContain('second version');
    expect(final).not.toContain('first version');
  });
});

describe('runTier25ForFolder — empty/error paths', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns empty / no_clusters when the folder has no clusters', async () => {
    const folder = ctx.folders.create('Empty');
    const stub = new StubProvider(async () => {
      throw new Error('should not be called');
    });
    const r = await runTier25ForFolder(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        folders: ctx.folders,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub,
        model: 'm',
      },
      folder.id,
    );
    expect(r.status).toBe('empty');
    if (r.status !== 'empty') return;
    expect(r.reason).toBe('no_clusters');
  });

  it('returns error / folder_not_found for a bogus folder id', async () => {
    const stub = new StubProvider(async () => {
      throw new Error('should not be called');
    });
    const r = await runTier25ForFolder(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        folders: ctx.folders,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub,
        model: 'm',
      },
      'no-such-folder',
    );
    expect(r.status).toBe('error');
    if (r.status !== 'error') return;
    expect(r.reason).toBe('folder_not_found');
  });

  it('returns error / budget_exceeded BEFORE the LLM call', async () => {
    const folder = ctx.folders.create('Over');
    seedClusterReady(ctx, folder.id, 'cluster-a', 1);
    ctx.ledger.record({ kind: 'mo_tool', costUsd: 11 });
    const stub = new StubProvider(async (req) => ({
      content: catalogBody('overview'),
      toolCalls: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      model: req.model,
    }));
    const r = await runTier25ForFolder(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        folders: ctx.folders,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub,
        budget: ctx.budget,
        model: 'm',
      },
      folder.id,
    );
    expect(r.status).toBe('error');
    if (r.status !== 'error') return;
    expect(r.reason).toBe('budget_exceeded');
    expect(stub.calls).toHaveLength(0);
  });

  it('returns error / invalid_response when LLM gives plain prose without anchors', async () => {
    const folder = ctx.folders.create('Bad');
    seedClusterReady(ctx, folder.id, 'cluster-a', 1);
    const stub = new StubProvider(async (req) => ({
      content: 'just prose, no anchored sections',
      toolCalls: [],
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.0001,
      model: req.model,
    }));
    const r = await runTier25ForFolder(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        folders: ctx.folders,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider: stub,
        budget: ctx.budget,
        model: 'm',
      },
      folder.id,
    );
    expect(r.status).toBe('error');
    if (r.status !== 'error') return;
    expect(r.reason).toBe('invalid_response');
  });
});

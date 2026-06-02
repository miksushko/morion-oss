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
  MoSpendLedgerRepository,
  MoMemoryRepository,
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  BudgetTracker,
  MoPatrolFindingsRepository,
  ensureCatalogNote,
  mergeCatalogDoc,
  renderCatalogSection,
  type Tier0Finding,
} from '../src/core/concierge/index.js';
import { buildHttpApp } from '../src/server/bootstrap/http.js';

/**
 * Phase 6.3 — `GET /api/concierge/folders/:id/risks`
 *
 * Combines two risk sources for the Project Risks tab:
 *   - Tier 2.5 catalog `risks` section (LLM-tier).
 *   - Tier 0 high-severity (p0/p1) open findings (deterministic tier).
 */

interface Ctx {
  handle: DbHandle;
  app: ReturnType<typeof buildHttpApp>;
  folders: FoldersRepository;
  notes: NotesRepository;
  findings: MoPatrolFindingsRepository;
}

function setup(): Ctx {
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
  const configDir = mkdtempSync(join(tmpdir(), 'morion-risks-route-'));

  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const sessions = new ConciergeSessionsRepository(handle.db);
  const cMessages = new ConciergeMessagesRepository(handle.db);
  const moSpendLedger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(moSpendLedger);
  const findings = new MoPatrolFindingsRepository(handle.db);

  const app = buildHttpApp({
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
    configDir,
    concierge: {
      folderSettings,
      sessions,
      messages: cMessages,
      moSpendLedger,
      moMemory,
      budget,
      moPatrolFindings: findings,
    },
  });

  return { handle, app, folders, notes, findings };
}

const finding = (
  kind: string,
  noteId: string,
  severity: Tier0Finding['severity'],
): Tier0Finding => ({
  kind: kind as Tier0Finding['kind'],
  severity,
  noteId,
  noteTitle: 'T',
  message: `${kind} fired at ${severity}`,
  context: {},
});

describe('GET /api/concierge/folders/:id/risks', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns 404 for an unknown folder', async () => {
    const res = await ctx.app.request(
      '/api/concierge/folders/nope/risks',
    );
    expect(res.status).toBe(404);
  });

  it('returns null catalog + empty findings for a fresh folder', async () => {
    const folder = ctx.folders.create('Empty');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/risks`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      folderId: string;
      catalog: { noteId: string | null; risks: string | null };
      findings: unknown[];
    };
    expect(body.folderId).toBe(folder.id);
    expect(body.catalog.noteId).toBeNull();
    expect(body.catalog.risks).toBeNull();
    expect(body.findings).toEqual([]);
  });

  it('extracts the risks section from the catalog when present', async () => {
    const folder = ctx.folders.create('F');
    const ensured = ensureCatalogNote(ctx.handle.db, folder.id, 'F');
    const merged = mergeCatalogDoc(
      ensured.body,
      renderCatalogSection(
        'risks',
        '- Stuck doing tickets pile up after Friday cuts\n- WKWebView dragstart regression watch',
      ),
      'F',
    );
    ctx.handle.db
      .prepare('UPDATE notes SET body = ? WHERE id = ?')
      .run(merged, ensured.id);

    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/risks`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      catalog: { noteId: string; risks: string | null };
    };
    expect(body.catalog.noteId).toBe(ensured.id);
    expect(body.catalog.risks).toContain('Stuck doing tickets');
    expect(body.catalog.risks).toContain('WKWebView dragstart');
  });

  it('treats placeholder copy as null risks', async () => {
    const folder = ctx.folders.create('F');
    // ensureCatalogNote uses skeleton with placeholder ('_No risks identified yet._')
    ensureCatalogNote(ctx.handle.db, folder.id, 'F');
    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/risks`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { catalog: { risks: string | null } };
    expect(body.catalog.risks).toBeNull();
  });

  it('returns only p0/p1 open findings — info / p2 / p3 dropped', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.findings.insertBatch(folder.id, [
      finding('stuck_doing', note.id, 'p0'),
      finding('no_tags', note.id, 'p1'),
      finding('short_body', note.id, 'p2'),
      finding('dup_candidate', note.id, 'info'),
    ]);

    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/risks`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      findings: Array<{ kind: string; severity: string }>;
    };
    expect(body.findings).toHaveLength(2);
    const sevs = body.findings.map((f) => f.severity).sort();
    expect(sevs).toEqual(['p0', 'p1']);
  });

  it('excludes accepted / dismissed findings — only state=open shows', async () => {
    const folder = ctx.folders.create('F');
    const note = ctx.notes.create(
      { body: '# A', folderId: folder.id, source: 'user' },
      'user',
    );
    const ids = ctx.findings.insertBatch(folder.id, [
      finding('stuck_doing', note.id, 'p0'),
      finding('no_tags', note.id, 'p1'),
    ]);
    ctx.findings.setState(ids[0]!, 'accept');

    const res = await ctx.app.request(
      `/api/concierge/folders/${folder.id}/risks`,
    );
    const body = (await res.json()) as { findings: Array<{ id: string }> };
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]!.id).toBe(ids[1]);
  });
});

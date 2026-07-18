import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/core/db/client.js';
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
} from '../src/core/concierge/index.js';
import { buildHttpApp } from '../src/server/bootstrap/http.js';

/**
 * Registration smoke for /api/concierge + /api/auto-code + /api/mo
 * routes. Pins the full URL surface of `registerConciergeRoutes` so a
 * refactor that splits the 5000-line file into per-domain modules
 * (folder-catalog / sessions / auto-code-runs / auto-code-merge / …)
 * cannot accidentally drop a register call. Failure mode: a missing
 * route shows up as "expected POST /api/X to be registered" in the
 * vitest output instead of a mystery 404 at runtime / dogfood.
 *
 * Behavioural coverage lives elsewhere (concierge-http,
 * concierge-topics-route, concierge-risks-route, merge-* libs). This
 * file is intentionally registration-only.
 */

function setupApp(): ReturnType<typeof buildHttpApp> {
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
  const configDir = mkdtempSync(join(tmpdir(), 'morion-route-registration-'));

  const folderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const sessions = new ConciergeSessionsRepository(handle.db);
  const cMessages = new ConciergeMessagesRepository(handle.db);
  const moSpendLedger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(moSpendLedger);

  return buildHttpApp({
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
    },
  });
}

// (method, path) pairs that registerConciergeRoutes MUST register.
// Order in this list does NOT matter — registration order matters
// only for static-vs-dynamic Hono trie ordering, which is asserted
// separately below.
const EXPECTED_ROUTES: ReadonlyArray<readonly [string, string]> = [
  // folder catalog / settings / topics / risks / logs
  ['GET', '/api/concierge/folders/:id/settings'],
  ['PUT', '/api/concierge/folders/:id/settings'],
  ['GET', '/api/concierge/folders/:id/catalog'],
  ['PATCH', '/api/concierge/folders/:id/catalog'],
  ['POST', '/api/concierge/folders/:id/reindex-all'],
  ['POST', '/api/concierge/folders/:id/topic-cleanup'],
  ['GET', '/api/concierge/folders/:id/topic-cleanup'],
  ['POST', '/api/concierge/folders/:id/regenerate-catalog'],
  ['GET', '/api/concierge/folders/:id/topics'],
  ['POST', '/api/concierge/folders/:id/topics'],
  ['GET', '/api/concierge/folders/:id/topics/:clusterId'],
  ['PATCH', '/api/concierge/folders/:id/topics/:clusterId'],
  ['POST', '/api/concierge/folders/:id/topics/:clusterId/regenerate'],
  ['GET', '/api/concierge/folders/:id/risks'],
  ['GET', '/api/concierge/folders/:id/logs'],
  // folder auto-code
  ['GET', '/api/concierge/folders/:id/auto-code/preflight'],
  ['GET', '/api/concierge/folders/:id/auto-code/workflow-resolution'],
  ['GET', '/api/concierge/folders/:id/auto-code/inflight'],
  ['POST', '/api/concierge/folders/:id/auto-code/enqueue'],
  ['POST', '/api/concierge/folders/:id/auto-code/tick'],
  // indexing tick + findings
  ['POST', '/api/concierge/mo-indexing-tick'],
  ['POST', '/api/concierge/findings/:id/acknowledge'],
  // auto-code runs (READ-ONLY status + diff + files)
  ['GET', '/api/auto-code/runs'],
  ['GET', '/api/auto-code/runs/batch'],
  ['GET', '/api/auto-code/runs/:id/paused-session'],
  ['GET', '/api/auto-code/runs/:id/merge-status'],
  ['GET', '/api/auto-code/runs/:id/diff-stat'],
  ['GET', '/api/auto-code/runs/:id/files'],
  ['GET', '/api/auto-code/runs/:id/files/content'],
  ['POST', '/api/auto-code/runs/:id/remove-worktree'],
  ['POST', '/api/auto-code/runs/:id/cancel'],
  // auto-code runs (MERGE family — 5 mutating handlers)
  ['POST', '/api/auto-code/runs/:id/merge'],
  ['POST', '/api/auto-code/runs/:id/merge-conflict-prepare'],
  ['POST', '/api/auto-code/runs/:id/merge-apply-resolution'],
  ['POST', '/api/auto-code/runs/:id/merge-ai-resolve'],
  ['POST', '/api/auto-code/runs/:id/merge-abort'],
  // auto-code queue (transcript surface)
  ['GET', '/api/auto-code/queue/:id/sessions'],
  ['GET', '/api/auto-code/queue/:id/transcript'],
  ['GET', '/api/auto-code/queue/:id/transcript/stream'],
  // auto-code budget + workflow CRUD
  ['GET', '/api/auto-code/budget'],
  ['PUT', '/api/auto-code/budget'],
  ['GET', '/api/auto-code/workflow-templates'],
  ['GET', '/api/auto-code/workflows'],
  ['POST', '/api/auto-code/workflows'],
  ['GET', '/api/auto-code/workflows/:id'],
  ['PUT', '/api/auto-code/workflows/:id'],
  ['DELETE', '/api/auto-code/workflows/:id'],
  ['POST', '/api/auto-code/workflows/:id/clone'],
  // sessions
  ['GET', '/api/concierge/sessions'],
  ['POST', '/api/concierge/sessions'],
  ['GET', '/api/concierge/sessions/search'],
  ['GET', '/api/concierge/sessions/:id'],
  ['PATCH', '/api/concierge/sessions/:id'],
  ['DELETE', '/api/concierge/sessions/:id'],
  ['GET', '/api/concierge/sessions/:id/messages'],
  ['POST', '/api/concierge/sessions/:id/messages'],
  ['GET', '/api/concierge/sessions/:id/tool-progress'],
  ['POST', '/api/concierge/sessions/:id/quick-action'],
  ['POST', '/api/concierge/sessions/:id/tool-approve'],
  // provider + per-pipeline + mo settings + budget
  ['GET', '/api/concierge/provider'],
  ['PUT', '/api/concierge/provider'],
  ['GET', '/api/concierge/pipeline-models'],
  ['PUT', '/api/concierge/pipeline-models'],
  ['GET', '/api/concierge/mo'],
  ['PUT', '/api/concierge/mo'],
  ['GET', '/api/concierge/budget'],
  ['PUT', '/api/concierge/budget'],
  // mo memory
  ['GET', '/api/mo/memory'],
  ['PUT', '/api/mo/memory'],
  // usage stats (ticket 01KRJSTN74FT7VRX6KAA42GGBS, slice 6)
  ['GET', '/api/usage'],
];

describe('Concierge route registration smoke', () => {
  const app = setupApp();
  const registered = new Set(
    app.routes.map((r) => `${r.method} ${r.path}`),
  );

  for (const [method, path] of EXPECTED_ROUTES) {
    it(`registers ${method} ${path}`, () => {
      expect(
        registered.has(`${method} ${path}`),
        `Expected ${method} ${path} to be registered by registerConciergeRoutes. ` +
          `Registered routes: ${[...registered].sort().join(', ')}`,
      ).toBe(true);
    });
  }

  it('covers every concierge / auto-code / mo-memory route currently in the app', () => {
    // Catches the OPPOSITE drift: a new route lands in the app without
    // being added to EXPECTED_ROUTES, so this smoke would silently
    // pass over it during a future refactor. Forces the dev to
    // acknowledge the new route by extending EXPECTED_ROUTES.
    const expectedSet = new Set(
      EXPECTED_ROUTES.map(([m, p]) => `${m} ${p}`),
    );
    const ourPrefix = (p: string) =>
      p.startsWith('/api/concierge/') ||
      p.startsWith('/api/auto-code/') ||
      p.startsWith('/api/mo/memory');
    const unexpected: string[] = [];
    for (const r of app.routes) {
      if (!ourPrefix(r.path)) continue;
      const key = `${r.method} ${r.path}`;
      if (!expectedSet.has(key)) unexpected.push(key);
    }
    expect(
      unexpected,
      `New route(s) registered without updating EXPECTED_ROUTES: ${unexpected.join(', ')}`,
    ).toEqual([]);
  });

  it('registers /sessions/search BEFORE /sessions/:id (Hono trie ordering: static wins over dynamic)', () => {
    // If split into separate modules, this asserts that the routes
    // are still registered in an order where Hono's trie matches the
    // literal "search" before falling into the :id capture. Drift
    // here is silent in unit tests but breaks "search by query" at
    // runtime.
    const sessionsRoutes = app.routes.filter(
      (r) =>
        r.path === '/api/concierge/sessions/search' ||
        r.path === '/api/concierge/sessions/:id',
    );
    const searchIdx = sessionsRoutes.findIndex(
      (r) => r.path === '/api/concierge/sessions/search',
    );
    const idIdx = sessionsRoutes.findIndex(
      (r) => r.path === '/api/concierge/sessions/:id',
    );
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(
      searchIdx < idIdx,
      `/sessions/search must register before /sessions/:id`,
    ).toBe(true);
  });

  it('registers /auto-code/runs/batch BEFORE /auto-code/runs/:id/*', () => {
    const idx = (path: string) =>
      app.routes.findIndex((r) => r.path === path && r.method === 'GET');
    const batchIdx = idx('/api/auto-code/runs/batch');
    const dynamicIdx = idx('/api/auto-code/runs/:id/diff-stat');
    expect(batchIdx).toBeGreaterThanOrEqual(0);
    expect(dynamicIdx).toBeGreaterThanOrEqual(0);
    expect(
      batchIdx < dynamicIdx,
      `/runs/batch must register before /runs/:id/* — else :id swallows "batch"`,
    ).toBe(true);
  });

  it('registers /auto-code/workflows (list) BEFORE /auto-code/workflows/:id', () => {
    const idx = (path: string) =>
      app.routes.findIndex((r) => r.path === path && r.method === 'GET');
    const listIdx = idx('/api/auto-code/workflows');
    const dynamicIdx = idx('/api/auto-code/workflows/:id');
    expect(listIdx).toBeGreaterThanOrEqual(0);
    expect(dynamicIdx).toBeGreaterThanOrEqual(0);
    expect(
      listIdx < dynamicIdx,
      `/workflows list must register before /workflows/:id`,
    ).toBe(true);
  });
});

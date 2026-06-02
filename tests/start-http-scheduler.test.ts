/**
 * Regression: `startHttpServer` did not construct or start
 * `ConciergeScheduler`. The scheduler implementation existed and tests
 * exercised it directly, but the production startup path silently
 * skipped it — timer-mode folders never auto-ticked, hourly Project
 * Brief digest never ran in the background. Manual launch kept
 * working, which hid the bug from dogfooding.
 *
 * Ticket: `01KQ1H4YVKJFVE05PG9WZBAB7E`. Fix routes engine + brief
 * deps through the new shared factory in `src/server/concierge-deps.ts`
 * so the route and the scheduler can never drift, then constructs
 * `ConciergeScheduler` inside `startHttpServer` and starts it.
 *
 * The shutdown signature changed from sync to async because
 * `ConciergeScheduler.stop()` is async (awaits inflight ticks). The
 * old sync close raced SIGTERM-to-process.exit and could lose a
 * tick mid-transaction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  MoMetadataQueueRepository,
  MoClusterQueueRepository,
} from '../src/core/concierge/index.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/core/concierge/index.js';
import { startHttpServer } from '../src/server/bootstrap/start.js';
import type { Runtime } from '../src/core/runtime.js';

// Recording provider — counts how many tick / brief calls actually
// happen. The real test is that ANY of these get hit when the user
// configures a timer folder, since the bug was "scheduler never
// started → zero calls forever."
class CountingProvider implements LLMProvider {
  readonly name = 'counting';
  calls: LLMRequest[] = [];
  nextResponse: LLMResponse = {
    content: '',
    toolCalls: [],
    tokensIn: 5,
    tokensOut: 5,
    costUsd: 0,
    model: 'counting-model',
  };
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    return this.nextResponse;
  }
}

interface Ctx {
  rt: Runtime;
  handle: DbHandle;
  provider: CountingProvider;
  folderId: string;
}

function buildRuntimeForTest(): Ctx {
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
  const cFolderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const cSessions = new ConciergeSessionsRepository(handle.db);
  const cMessages = new ConciergeMessagesRepository(handle.db);
  const moSpendLedger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(moSpendLedger);
  // Phase 1 indexing repos — required by the new ConciergeBag shape.
  // The indexing tick in this test is gated off (backend isn't
  // openrouter) so these are wired but never actually drained.
  const moMetadata = new NoteMoMetadataRepository(handle.db);
  const moClusters = new NoteMoClustersRepository(handle.db);
  const moMetadataQueue = new MoMetadataQueueRepository(handle.db);
  const moClusterQueue = new MoClusterQueueRepository(handle.db);
  const folder = folders.create('Timer test');
  const provider = new CountingProvider();
  // Inject the recording provider through the concierge bag's
  // `providerOverride` test escape hatch — same hook the chat path
  // uses. Both engine deps and brief deps will pick it up via
  // `readProviderModel`.
  const concierge = {
    folderSettings: cFolderSettings,
    sessions: cSessions,
    messages: cMessages,
    moSpendLedger,
    moMemory,
    budget,
    moMetadata,
    moClusters,
    moMetadataQueue,
    moClusterQueue,
    providerOverride: provider,
  };
  // Workspace timer mode at 1-minute cadence + folder enabled +
  // checking-corners off (keeps brief out of this test).
  settings.set('concierge.schedule_mode', 'timer');
  settings.set('concierge.schedule_minutes', 1);
  settings.set('concierge.checking_corners_master', false);
  cFolderSettings.update(folder.id, { enabled: true, workflow: 'observe' });
  // Random pick of dbPath for `dirname(rt.config.dbPath)` — never read
  // because the scheduler doesn't touch attachments.
  const configDir = mkdtempSync(join(tmpdir(), 'morion-scheduler-startup-'));
  const config = {
    dbPath: join(configDir, 'morion.db'),
    httpHost: '127.0.0.1',
    httpPort: 0, // OS assigns a free port
    embeddings: { provider: 'noop' as const, model: 'noop' },
  };
  const rt: Runtime = {
    config: config as unknown as Runtime['config'],
    handle,
    audit,
    settings,
    notes,
    folders,
    tags,
    revisions,
    attachments,
    comments,
    concierge,
    fts,
    vec,
    search,
    indexer,
    embeddings,
  };
  return { rt, handle, provider, folderId: folder.id };
}

describe('startHttpServer wires ConciergeScheduler (01KQ1H4YVKJFVE05PG9WZBAB7E)', () => {
  let ctx: Ctx;
  let started: ReturnType<typeof startHttpServer>;

  beforeEach(() => {
    ctx = buildRuntimeForTest();
  });

  afterEach(async () => {
    if (started) {
      try {
        started.server.close();
      } catch {
        // ignore — server may already be closing
      }
      await started.shutdown();
    }
  });

  it('returns a non-null scheduler in the StartedServer envelope', () => {
    started = startHttpServer(ctx.rt, {
      onReady: () => {},
      schedulerPollIntervalMs: 50,
    });
    expect(started.scheduler).not.toBeNull();
  });

  it('disableScheduler=true returns scheduler=null (test harness escape hatch)', () => {
    started = startHttpServer(ctx.rt, {
      onReady: () => {},
      disableScheduler: true,
    });
    expect(started.scheduler).toBeNull();
  });

  // Tests for the autonomous per-folder timer tick + shutdown-awaits-
  // tick removed 2026-05-03 along with the autonomous Mo agent. The
  // shutdown-awaits-inflight contract is still exercised by the
  // indexing tick path in tests/scheduler-indexing-vs-manual-mode.test.ts.
});

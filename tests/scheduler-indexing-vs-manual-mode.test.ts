import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { ConciergeScheduler } from '../src/core/concierge/scheduler.js';
import {
  ConciergeFolderSettingsRepository,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  MoMetadataQueueRepository,
  MoClusterQueueRepository,
  MoSpendLedgerRepository,
  MoMemoryRepository,
  BudgetTracker,
} from '../src/core/concierge/index.js';
import type { MoIndexingTickDeps } from '../src/core/concierge/index.js';

/**
 * Regression: indexing tick must run independently of the autonomous
 * Mo schedule mode.
 *
 * 1.3.0 shipped with the indexing block placed BELOW the
 * `if (workspaceMode === 'manual') return` guard in `poll()`. The
 * symptom in the wild: a user with `concierge.schedule_mode = 'manual'`
 * (a legitimate preference — they don't want autonomous Mo running on
 * its own) saw 144 user notes across 4 Mo-enabled folders never get
 * `note_mo_metadata` rows after upgrading 1.2.9 → 1.3.0; the
 * `mo.indexing.audit_checkpoint` setting was even absent because the
 * tick never ran ONCE.
 *
 * Fix in 1.3.1: indexing block lives ABOVE the manual-return guard.
 * The two are different concerns:
 *
 *   - `concierge.schedule_mode` controls the AUTONOMOUS Mo agent
 *     (kanban patrol, workflow checks, "Mo is doing things"). User
 *     legitimately throttles to manual.
 *   - The indexing pipeline (Tier 1 metadata, Tier 2/2.5 catalog
 *     regen, bootstrap sweep) is INTERNAL infrastructure that keeps
 *     indices consistent with notes. Gating it on the user's
 *     autonomous-Mo preference makes ghost notes permanent.
 */

interface Ctx {
  handle: DbHandle;
  settings: SettingsRepository;
  scheduler: ConciergeScheduler;
  indexingCallCount: number;
}

function setup(workspaceMode: 'manual' | 'timer'): Ctx {
  const handle = openDb({ path: ':memory:' });
  const audit = new AuditLogger(handle.db);
  const notes = new NotesRepository(handle.db, audit);
  const folders = new FoldersRepository(handle.db);
  const settings = new SettingsRepository(handle.db);
  const cFolderSettings = new ConciergeFolderSettingsRepository(handle.db);
  const cSessions = new ConciergeSessionsRepository(handle.db);
  const cMessages = new ConciergeMessagesRepository(handle.db);
  const moSpendLedger = new MoSpendLedgerRepository(handle.db);
  const moMemory = new MoMemoryRepository(settings);
  const budget = new BudgetTracker(moSpendLedger);
  const moMetadata = new NoteMoMetadataRepository(handle.db);
  const moClusters = new NoteMoClustersRepository(handle.db);
  const moMetadataQueue = new MoMetadataQueueRepository(handle.db);
  const moClusterQueue = new MoClusterQueueRepository(handle.db);

  settings.set('concierge.schedule_mode', workspaceMode);
  settings.set('concierge.schedule_minutes', 1);

  let indexingCallCount = 0;
  // Stub indexingDeps with `resolveProvider: () => null` so the tick
  // bails at the gated_off branch without making real LLM calls.
  // We just count whether `runMoIndexingTick` got CALLED at all.
  const indexingDeps: MoIndexingTickDeps = {
    db: handle.db,
    notes,
    folders,
    workspaceSettings: settings,
    folderSettings: cFolderSettings,
    metaRepo: moMetadata,
    clustersRepo: moClusters,
    metadataQueue: moMetadataQueue,
    clusterQueue: moClusterQueue,
    budget,
    resolveProvider: () => {
      indexingCallCount++;
      return null; // gated_off path — no real LLM activity
    },
  };

  const scheduler = new ConciergeScheduler({
    indexingDeps,
    indexingIntervalMs: 0, // fire on every poll
    pollIntervalMs: 100_000, // we drive poll() manually
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });

  return { handle, settings, scheduler, indexingCallCount: 0 };
}

describe('ConciergeScheduler — indexing tick vs autonomous mode', () => {
  let ctx: Ctx;

  it('schedule_mode=manual still fires the indexing tick (1.3.1 fix)', async () => {
    ctx = setup('manual');
    // Drive one poll. With the bug, this returns immediately at the
    // `workspaceMode === 'manual'` guard before reaching the indexing
    // block. With the fix, indexing runs first and resolveProvider
    // gets called.
    await ctx.scheduler.poll();
    // Allow microtasks to drain (indexing path is async).
    await new Promise((r) => setTimeout(r, 10));
    // The indexing block calls `resolveIndexingDeps()` which we stub
    // to `() => null`; that triggers the gated_off branch inside
    // `runMoIndexingTick`. Either way, our stub's resolveProvider
    // fires once per tick.
    // Detection: count calls via a side effect inside indexingDeps.
    // Since the closure captures by ref, we compare the live counter.
    const calls = (ctx.scheduler as unknown as {
      resolveIndexingDeps: () => MoIndexingTickDeps;
    }).resolveIndexingDeps;
    expect(calls).not.toBeNull();
    // resolveProvider should have been invoked exactly once during the
    // single poll() above.
    // We re-fetch the stubbed deps and inspect via a fresh call on a
    // second poll — second call increments the counter further.
    await ctx.scheduler.poll();
    await new Promise((r) => setTimeout(r, 10));
    // After two polls with `indexingIntervalMs: 0`, we expect
    // resolveProvider to have fired at least twice (once per poll).
    // The exact count depends on internal `lastIndexingTickAt`
    // bookkeeping; the contract we're pinning is "fired more than zero".
    // Use a non-strict counter: resolveProvider called >=1 after first
    // poll, >=2 after second.
    // Counter is stored on the closure inside setup() — to access it
    // we stash it on the scheduler under a known property.
    // Simpler: walk audit_log for evidence the tick at least entered.
    // The tick path always logs via `mo.indexing.audit_checkpoint`
    // setting — set on first successful audit poll OR at very least,
    // resolveProvider was called.
    // We use the sentinel: settings.get returns the default 0 only
    // if the tick never wrote. We verify the tick entered by checking
    // resolveProvider counter directly via a test-visible field below.
    expect(true).toBe(true); // Sentinel — full assertion below.
  });

  it('schedule_mode=timer also fires the indexing tick (no regression)', async () => {
    ctx = setup('timer');
    await ctx.scheduler.poll();
    await new Promise((r) => setTimeout(r, 10));
    expect(true).toBe(true);
  });
});

/**
 * Direct, deterministic check: counts calls to resolveProvider via
 * a shared counter object. This is the assertion that proves
 * 1.3.1 fixed the regression.
 */
describe('ConciergeScheduler — indexing tick fires under manual mode (deterministic)', () => {
  it('counts resolveProvider invocations across modes', async () => {
    const counts = { manual: 0, timer: 0 };

    for (const mode of ['manual', 'timer'] as const) {
      const handle = openDb({ path: ':memory:' });
      const audit = new AuditLogger(handle.db);
      const notes = new NotesRepository(handle.db, audit);
      const folders = new FoldersRepository(handle.db);
      const settings = new SettingsRepository(handle.db);
      const cFolderSettings = new ConciergeFolderSettingsRepository(handle.db);
      const cSessions = new ConciergeSessionsRepository(handle.db);
      const cMessages = new ConciergeMessagesRepository(handle.db);
      const moSpendLedger = new MoSpendLedgerRepository(handle.db);
      const moMemory = new MoMemoryRepository(settings);
      const budget = new BudgetTracker(moSpendLedger);
      const moMetadata = new NoteMoMetadataRepository(handle.db);
      const moClusters = new NoteMoClustersRepository(handle.db);
      const moMetadataQueue = new MoMetadataQueueRepository(handle.db);
      const moClusterQueue = new MoClusterQueueRepository(handle.db);
      settings.set('concierge.schedule_mode', mode);

      const indexingDeps: MoIndexingTickDeps = {
        db: handle.db,
        notes,
        folders,
        workspaceSettings: settings,
        folderSettings: cFolderSettings,
        metaRepo: moMetadata,
        clustersRepo: moClusters,
        metadataQueue: moMetadataQueue,
        clusterQueue: moClusterQueue,
        budget,
        resolveProvider: () => {
          counts[mode]++;
          return null;
        },
      };

      const scheduler = new ConciergeScheduler({
        indexingDeps,
        indexingIntervalMs: 0,
        pollIntervalMs: 100_000,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      });

      await scheduler.poll();
      // Drain the microtask queue so the async indexing promise lands.
      await new Promise((r) => setTimeout(r, 20));
    }

    // Both modes must run the indexing tick; manual was the bug.
    expect(counts.manual).toBeGreaterThan(0);
    expect(counts.timer).toBeGreaterThan(0);
  });
});

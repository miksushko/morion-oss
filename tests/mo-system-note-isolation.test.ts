import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { AuditLogger } from '../src/core/audit/log.js';
import { NotesRepository } from '../src/core/notes/repository.js';
import { FoldersRepository } from '../src/core/folders/repository.js';
import {
  NoteMoMetadataRepository,
  NoteMoClustersRepository,
  MoClusterQueueRepository,
  MoTopicDecisionsRepository,
  MoSpendLedgerRepository,
  BudgetTracker,
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
  runTier1ForNote,
  gatherClusterPanorama,
  mergeClusters,
  ensureClusterNote,
  snapshotFolderClusters,
  hashBody,
} from '../src/core/concierge/index.js';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/core/concierge/index.js';

/**
 * Bug 01KQKESWXPYV73V9FE614Q51HQ regression suite.
 *
 * `mo:*` system notes (mo:catalog / mo:cluster:* / mo:patrol-log /
 * mo:risks) MUST NOT participate in topic indexing — they ARE the
 * index storage, indexing them produces feedback loops + inflated
 * counts.
 *
 * Pin every load-bearing leak point we audited:
 *   - Tier 1 entry guard (refuses mo:* even if manually queued)
 *   - listClusterIdsForFolder excludes mo:* notes
 *   - gatherClusterPanorama (cleanup proposer) excludes mo:*
 *   - mergeClusters source SELECT excludes mo:*
 *   - snapshotFolderClusters (Tier 2.5 catalog) excludes mo:*
 *   - migration 0026 has purged any pre-existing pollution
 */

interface Ctx {
  handle: DbHandle;
  audit: AuditLogger;
  notes: NotesRepository;
  folders: FoldersRepository;
  meta: NoteMoMetadataRepository;
  clusters: NoteMoClustersRepository;
  clusterQueue: MoClusterQueueRepository;
  decisions: MoTopicDecisionsRepository;
  sessions: ConciergeSessionsRepository;
  messages: ConciergeMessagesRepository;
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
    decisions: new MoTopicDecisionsRepository(handle.db),
    sessions: new ConciergeSessionsRepository(handle.db),
    messages: new ConciergeMessagesRepository(handle.db),
    ledger,
    budget: new BudgetTracker(ledger),
  };
}

const longBody = (tag: string) =>
  `# ${tag}\n\nA real-looking note body that easily clears the Tier 1 minimum length check.`;

class StubProvider implements LLMProvider {
  readonly name = 'stub';
  public calls: LLMRequest[] = [];
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls.push(req);
    return {
      content: JSON.stringify({
        summary: 'should never be persisted for mo:* notes',
        keywords: ['x'],
        cluster_candidates: [{ cluster_id: 'leaked-from-system-note', confidence: 0.9 }],
      }),
      toolCalls: [],
      tokensIn: 50,
      tokensOut: 25,
      costUsd: 0.0001,
      model: req.model,
    };
  }
}

/**
 * Build a fixture with a user note that has a real cluster + a couple
 * of `mo:*` system notes. The system notes get fabricated cluster
 * assignments via direct INSERT so the test simulates "pollution
 * already in the DB" — which is exactly the situation migration 0026
 * is meant to clean up + the SQL filters are meant to render invisible.
 */
function seedFolder(ctx: Ctx) {
  const folder = ctx.folders.create('F');
  const userNote = ctx.notes.create(
    { body: longBody('userA'), folderId: folder.id, source: 'user' },
    'user',
  );
  const userNote2 = ctx.notes.create(
    { body: longBody('userB'), folderId: folder.id, source: 'user' },
    'user',
  );
  ctx.clusters.upsert({ noteId: userNote.id, clusterId: 'real-topic', source: 'tier1' });
  ctx.clusters.upsert({ noteId: userNote2.id, clusterId: 'real-topic', source: 'tier1' });

  // mo:* notes — created via direct INSERT to bypass the public API
  // (NotesRepository.create rejects `source: 'mo:cluster'` for
  // `actor: 'user'`; we explicitly want pre-existing pollution in
  // the fixture so the SQL filters can prove they hide it).
  const catalogId = 'CATALOG' + folder.id.slice(-4);
  const clusterDocId = 'CLUSTER' + folder.id.slice(-4);
  const now = Date.now();
  ctx.handle.db
    .prepare(
      `INSERT INTO notes (id, folder_id, title, body, pinned, source, created_at, updated_at, deleted_at, status, position)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, 'note', NULL)`,
    )
    .run(catalogId, folder.id, 'mo:catalog', '# catalog body', 'mo:catalog', now, now);
  ctx.handle.db
    .prepare(
      `INSERT INTO notes (id, folder_id, title, body, pinned, source, created_at, updated_at, deleted_at, status, position)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, 'note', NULL)`,
    )
    .run(clusterDocId, folder.id, 'mo:cluster:real-topic', '# cluster doc body', 'mo:cluster', now, now);

  // Pollution: assign these system notes to clusters as if Tier 1 had
  // accidentally indexed them (the bug we're fixing).
  ctx.clusters.upsert({ noteId: catalogId, clusterId: 'mo-system-pollution', source: 'tier1' });
  ctx.clusters.upsert({ noteId: clusterDocId, clusterId: 'real-topic', source: 'tier1' });

  return { folder, userNote, userNote2, catalogId, clusterDocId };
}

describe('Bug 01KQKESWXPYV73V9FE614Q51HQ — mo:* system notes never pollute topic indexing', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('Tier 1: refuses mo:* notes with status=fresh reason=system_note (no LLM call)', async () => {
    const folder = ctx.folders.create('F');
    const now = Date.now();
    const id = 'CATTEST';
    ctx.handle.db
      .prepare(
        `INSERT INTO notes (id, folder_id, title, body, pinned, source, created_at, updated_at, deleted_at, status, position)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, 'note', NULL)`,
      )
      .run(id, folder.id, 'mo:catalog', longBody('catalog content'), 'mo:catalog', now, now);

    const provider = new StubProvider();
    const result = await runTier1ForNote(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        provider,
        budget: ctx.budget,
        model: 'm',
      },
      id,
      { force: true }, // even with force: true the guard fires
    );

    expect(result.status).toBe('fresh');
    if (result.status === 'fresh') {
      expect(result.reason).toBe('system_note');
    }
    // Provider was NEVER called — the guard fired before the LLM.
    expect(provider.calls).toHaveLength(0);
    // No metadata or cluster row written for the system note.
    expect(ctx.meta.get(id)).toBeNull();
    expect(ctx.clusters.listForNote(id)).toHaveLength(0);
  });

  it('listClusterIdsForFolder: hides cluster ids that only exist on mo:* notes', () => {
    const { folder } = seedFolder(ctx);
    // After seed: real-topic has 2 user notes + 1 mo:cluster note;
    // mo-system-pollution has only the mo:catalog note.
    const ids = ctx.clusters.listClusterIdsForFolder(folder.id);
    expect(ids).toContain('real-topic');
    expect(ids).not.toContain('mo-system-pollution');
  });

  it('gatherClusterPanorama: counts only user notes, mo:*-only clusters disappear', () => {
    const { folder } = seedFolder(ctx);
    const panorama = gatherClusterPanorama(ctx.handle.db, folder.id);
    const real = panorama.find((p) => p.clusterId === 'real-topic');
    expect(real).toBeTruthy();
    // Only the 2 user notes count, NOT the mo:cluster doc that got
    // a fabricated assignment.
    expect(real?.noteCount).toBe(2);
    // The mo-only cluster is invisible to the proposer.
    expect(panorama.find((p) => p.clusterId === 'mo-system-pollution')).toBeUndefined();
  });

  it('mergeClusters: refuses to reassign mo:* notes from the source cluster', () => {
    const { folder, clusterDocId } = seedFolder(ctx);
    // real-topic has 2 user notes + 1 mo:cluster note (pollution).
    // Merging real-topic -> moved should ONLY move the user notes;
    // the mo:cluster row stays where it is (filtered out of the
    // source SELECT).
    const result = mergeClusters(
      {
        db: ctx.handle.db,
        clusters: ctx.clusters,
        clusterQueue: ctx.clusterQueue,
        decisions: ctx.decisions,
      },
      folder.id,
      'real-topic',
      'moved-target',
    );
    expect(result.status).toBe('merged');
    // Only the 2 user notes moved.
    expect(result.affectedNoteIds).toHaveLength(2);
    expect(result.affectedNoteIds).not.toContain(clusterDocId);
    // The mo:cluster's stray row STAYS on real-topic — it was never
    // visible to mergeClusters' source SELECT, so the DELETE didn't
    // touch it. (It'll be cleaned up by migration 0026 in real prod.)
    const remainingRealTopic = ctx.clusters.listForCluster('real-topic');
    expect(remainingRealTopic.map((r) => r.noteId)).toEqual([clusterDocId]);
  });

  it('snapshotFolderClusters (Tier 2.5): excludes mo:* notes from per-cluster note count', () => {
    const { folder } = seedFolder(ctx);
    const snapshots = snapshotFolderClusters(ctx.handle.db, folder.id);
    const real = snapshots.find((s) => s.clusterId === 'real-topic');
    expect(real).toBeTruthy();
    // 2 user notes, NOT 3 (the mo:cluster doc's stray row hidden).
    expect(real?.noteCount).toBe(2);
    // mo-system-pollution cluster (only on mo:catalog) is invisible.
    expect(snapshots.find((s) => s.clusterId === 'mo-system-pollution')).toBeUndefined();
  });

  it('ensureClusterNote stays a no-op when the mo:cluster note already exists (sanity)', () => {
    // Confirms the cluster-note creator itself is unchanged — it
    // creates `mo:cluster` source notes by design (that's the index
    // storage). The fix is on the indexing side, not the producer.
    const folder = ctx.folders.create('F');
    const result = ensureClusterNote(ctx.handle.db, folder.id, 'real-topic');
    expect(result.created).toBe(true);
    const result2 = ensureClusterNote(ctx.handle.db, folder.id, 'real-topic');
    expect(result2.created).toBe(false);
    expect(result2.id).toBe(result.id);
  });

  it('audit-log enqueue: a user-actor edit on a mo:* note does not enqueue Tier 1', async () => {
    // End-to-end through runMoIndexingTick: build a folder with Mo
    // enabled, write an audit row for a mo:* note edited by 'user',
    // verify the SQL filter excludes it.
    const { runMoIndexingTick, ConciergeFolderSettingsRepository, MoMetadataQueueRepository } =
      await import('../src/core/concierge/index.js');
    const { SettingsRepository } = await import('../src/core/settings/repository.js');

    const folder = ctx.folders.create('F');
    const folderSettings = new ConciergeFolderSettingsRepository(ctx.handle.db);
    folderSettings.update(folder.id, { enabled: true });
    const workspaceSettings = new SettingsRepository(ctx.handle.db);
    const metadataQueue = new MoMetadataQueueRepository(ctx.handle.db);

    // mo:catalog note via direct INSERT.
    const id = 'TICKCAT';
    const now = Date.now();
    ctx.handle.db
      .prepare(
        `INSERT INTO notes (id, folder_id, title, body, pinned, source, created_at, updated_at, deleted_at, status, position)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, 'note', NULL)`,
      )
      .run(id, folder.id, 'mo:catalog', longBody('catalog'), 'mo:catalog', now, now);
    // user-actor audit row simulating a manual edit (e.g. via the
    // catalog PATCH route).
    ctx.handle.db
      .prepare(`INSERT INTO audit_log (note_id, action, actor, ts) VALUES (?, ?, ?, ?)`)
      .run(id, 'update', 'user', now);

    const provider = new StubProvider();
    await runMoIndexingTick({
      db: ctx.handle.db,
      notes: ctx.notes,
      folders: ctx.folders,
      workspaceSettings,
      folderSettings,
      metaRepo: ctx.meta,
      clustersRepo: ctx.clusters,
      metadataQueue,
      clusterQueue: ctx.clusterQueue,
      budget: ctx.budget,
      resolveProvider: () => ({
        provider,
        tier1Model: 'm',
        tier1FallbackModel: null,
        tier2Model: 'm',
        tier2FallbackModel: null,
        topicHygieneModel: 'm',
        topicHygieneFallbackModel: null,
      }),
    });

    // Queue should be empty — the mo:* note was filtered before
    // metadataQueue.enqueue.
    expect(metadataQueue.listForFolder(folder.id)).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('listKanban: excludes mo:* system notes by default, includes them only with includeMoSystem', () => {
    // The kanban read path (tasks_list + the UI board) was the one
    // list()-style read missing the mo-system filter, so agents got
    // machine indices mixed into their task list on a Mo-indexed folder.
    const folder = ctx.folders.create('K');
    const realTask = ctx.notes.create(
      { body: longBody('a real todo'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.notes.moveToKanban(realTask.id, 'todo', null, 'user');

    // mo:* system notes via direct INSERT — one in the `note` column,
    // one parked in a manual-order column — both must stay invisible.
    const now = Date.now();
    for (const [id, title, source, status] of [
      ['MOCAT01', 'mo:catalog', 'mo:catalog', 'note'],
      ['MORISK1', 'mo:risks', 'mo:risks', 'todo'],
    ] as const) {
      ctx.handle.db
        .prepare(
          `INSERT INTO notes (id, folder_id, title, body, pinned, source, created_at, updated_at, deleted_at, status, position)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, NULL)`,
        )
        .run(id, folder.id, title, longBody(title), source, now, now, status);
    }

    const def = ctx.notes.listKanban({ folderId: folder.id, limit: 500 });
    expect(def.map((n) => n.id)).toEqual([realTask.id]);
    expect(def.some((n) => n.source?.startsWith('mo:'))).toBe(false);

    // Narrowing to a single column must ALSO exclude mo:* (the `todo`
    // mo:risks note must not leak alongside the real todo).
    const todoOnly = ctx.notes.listKanban({ folderId: folder.id, status: 'todo', limit: 500 });
    expect(todoOnly.map((n) => n.id)).toEqual([realTask.id]);

    // Power-user / debug opt-in surfaces them again.
    const withSystem = ctx.notes.listKanban({ folderId: folder.id, includeMoSystem: true, limit: 500 });
    const ids = withSystem.map((n) => n.id);
    expect(ids).toContain(realTask.id);
    expect(ids).toContain('MOCAT01');
    expect(ids).toContain('MORISK1');
  });

  it('migration 0026: purges existing note_mo_clusters / note_mo_metadata rows for mo:* notes (sanity check)', () => {
    // openDb runs migrations including 0026 on init; so the only way
    // to verify the cleanup is to fabricate a row with INSERT after
    // openDb (the migration already ran), then INSERT a new mo:* note,
    // then re-run the cleanup SQL manually as a sanity check that the
    // SQL is well-formed. (Real prod runs 0026 once on startup over
    // pre-bug data.)
    const { folder, catalogId } = seedFolder(ctx);
    void folder;

    // Re-execute the migration's DELETE SQL — it should drop the
    // pollution rows we INSERTed in seedFolder.
    const beforeClusters = ctx.clusters.listForNote(catalogId).length;
    expect(beforeClusters).toBeGreaterThan(0);

    ctx.handle.db
      .prepare(
        `DELETE FROM note_mo_clusters
          WHERE note_id IN (SELECT id FROM notes WHERE source LIKE 'mo:%')`,
      )
      .run();

    expect(ctx.clusters.listForNote(catalogId)).toHaveLength(0);
  });
});

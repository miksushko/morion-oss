import { describe, it, expect, beforeEach } from 'vitest';
import {
  runMoIndexingTick,
  MO_INDEXING_AUDIT_CHECKPOINT_KEY,
  hashBody,
} from '../../src/core/concierge/index.js';
import {
  buildDeps,
  longBody,
  setup,
  StubProvider,
  tier1Json,
  type Ctx,
} from '../helpers/mo-indexing-tick-setup.js';

describe('runMoIndexingTick — happy path', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('polls audit_log, enqueues, drains, and advances checkpoint', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    const note = ctx.notes.create(
      { body: longBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );

    const provider = new StubProvider(tier1Json);
    const summary = await runMoIndexingTick(
      buildDeps(ctx, {
        provider,
        tier1Model: 'mistralai/mistral-nemo',
        tier1FallbackModel: null,
        tier2Model: "qwen/qwen3-235b-a22b-2507",
        tier2FallbackModel: null,
      }),
    );

    expect(summary.status).toBe('ok');
    expect(summary.enqueued).toBe(1);
    expect(summary.worker?.computed).toBe(1);

    // Metadata persisted.
    const meta = ctx.meta.get(note.id);
    expect(meta?.bodyHash).toBe(hashBody(longBody('A')));
    expect(meta?.summary).toContain('test ticket');

    // Cluster persisted.
    const clusters = ctx.clusters.listForNote(note.id);
    expect(clusters.map((c) => c.clusterId)).toEqual(['kanban-ui']);

    // Cluster queue marked dirty.
    expect(
      ctx.clusterQueue.listForFolder(folder.id).map((q) => q.clusterId),
    ).toEqual(['kanban-ui']);

    // Checkpoint advanced past the audit row's id.
    const cp = ctx.workspaceSettings.get<number>(
      MO_INDEXING_AUDIT_CHECKPOINT_KEY,
      0,
    );
    expect(cp).toBeGreaterThan(0);
  });

  it('seeds the Tier 1 prompt with existing cluster ids of the note\'s folder (P0 prevention fix)', async () => {
    // Regression for the topic-drift bug: production caller used to
    // call drainTier1Queue WITHOUT a knownClustersFor resolver, so
    // every Tier 1 prompt took the empty-folder branch ("propose new
    // cluster ids") and singletons piled up — 376 clusters / 142 notes
    // observed on Morion Features (2026-05-02). The fix wires a
    // resolver that reads existing cluster ids per folder; this test
    // pins that the production path actually feeds them to the model.
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });

    // Pre-existing notes already classified into two clusters. Slugs
    // intentionally avoid words that appear in the static prompt
    // template (the template cites `kanban-ui` / `mo-chat-loop` /
    // `import-pipeline` / `tiptap` as examples).
    const seedA = ctx.notes.create(
      { body: longBody('seedA'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: seedA.id, clusterId: 'flux-handlers', source: 'tier1' });
    const seedB = ctx.notes.create(
      { body: longBody('seedB'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: seedB.id, clusterId: 'webhook-router', source: 'tier1' });

    // Reset checkpoint so the fresh-note write (next) is the only thing
    // the tick processes — keeps the assertion focused.
    ctx.workspaceSettings.set(MO_INDEXING_AUDIT_CHECKPOINT_KEY, Date.now());

    // The new note we want Tier 1 to classify.
    const fresh = ctx.notes.create(
      { body: longBody('fresh'), folderId: folder.id, source: 'user' },
      'user',
    );

    const provider = new StubProvider(tier1Json);
    const summary = await runMoIndexingTick(
      buildDeps(ctx, {
        provider,
        tier1Model: 'mistralai/mistral-nemo',
        tier1FallbackModel: null,
        tier2Model: 'qwen/qwen3-235b-a22b-2507',
        tier2FallbackModel: null,
      }),
    );
    expect(summary.status).toBe('ok');
    expect(summary.worker?.computed).toBeGreaterThanOrEqual(1);

    // Find the Tier 1 call for the fresh note (StubProvider records
    // every request). Tier 1 system prompts contain "JSON ONLY" — Tier
    // 2 calls do not, so we filter on that to skip any Tier 2 traffic
    // that may also be in the call list.
    const tier1Calls = provider.calls.filter((c) => {
      const sys = c.messages.find((m) => m.role === 'system');
      const sysContent =
        typeof sys?.content === 'string'
          ? sys.content
          : JSON.stringify(sys?.content ?? '');
      return sysContent.includes('indexing assistant');
    });
    expect(tier1Calls.length).toBeGreaterThanOrEqual(1);

    const freshCall = tier1Calls.find((c) => {
      const userMsg = c.messages.find((m) => m.role === 'user');
      const userContent =
        typeof userMsg?.content === 'string'
          ? userMsg.content
          : JSON.stringify(userMsg?.content ?? '');
      return userContent.includes('Tag=fresh');
    });
    expect(freshCall).toBeTruthy();

    const sys = freshCall!.messages.find((m) => m.role === 'system');
    const sysContent =
      typeof sys!.content === 'string'
        ? sys!.content
        : JSON.stringify(sys!.content);
    // The load-bearing assertion: the populated branch fired.
    expect(sysContent).toContain('Known cluster ids');
    expect(sysContent).toContain('flux-handlers');
    expect(sysContent).toContain('webhook-router');
    expect(sysContent).not.toContain('No clusters exist');

    // Sanity: the new note went somewhere.
    void fresh;
  });

  it('returns no_work on a second tick with no new audit rows', async () => {
    const folder = ctx.folders.create('F');
    ctx.folderSettings.update(folder.id, { enabled: true });
    ctx.notes.create(
      { body: longBody('A'), folderId: folder.id, source: 'user' },
      'user',
    );
    const provider = new StubProvider(tier1Json);
    const deps = buildDeps(ctx, {
      provider,
      tier1Model: 'mistralai/mistral-nemo',
      tier1FallbackModel: null,
        tier2Model: "qwen/qwen3-235b-a22b-2507",
        tier2FallbackModel: null,
    });

    const first = await runMoIndexingTick(deps);
    expect(first.status).toBe('ok');

    const second = await runMoIndexingTick(deps);
    expect(second.status).toBe('no_work');
    expect(second.enqueued).toBe(0);
    expect(second.worker?.claimed).toBe(0);
  });
});

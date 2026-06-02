import { describe, it, expect, beforeEach } from 'vitest';
import { drainTier1Queue, hashBody } from '../../src/core/concierge/index.js';
import {
  StubProvider,
  longBody,
  okResponse,
  setupMoTier1WorkerCtx,
  type MoTier1WorkerCtx,
} from '../helpers/mo-tier1-worker-setup.js';

describe('drainTier1Queue — knownClustersFor wiring', () => {
  let ctx: MoTier1WorkerCtx;
  beforeEach(() => {
    ctx = setupMoTier1WorkerCtx();
  });

  it('passes per-folder cluster ids into the Tier 1 prompt and memoises across rows', async () => {
    const folderA = ctx.folders.create('Folder A');
    const folderB = ctx.folders.create('Folder B');

    // Seed each folder with a couple of existing clusters via a prior
    // assignment — `listClusterIdsForFolder` reads from
    // `note_mo_clusters` JOIN notes, so we need real notes-with-clusters
    // for the resolver to find anything. Slugs deliberately use words
    // that don't appear in the static prompt template (the template
    // cites `kanban-ui` / `mo-chat-loop` / `import-pipeline` / `tiptap`
    // as examples, so any assertion against those would be ambiguous).
    const seedA = ctx.notes.create(
      { body: longBody('seedA'), folderId: folderA.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: seedA.id, clusterId: 'flux-handlers', source: 'tier1' });
    ctx.clusters.upsert({ noteId: seedA.id, clusterId: 'webhook-router', source: 'tier1' });
    const seedB = ctx.notes.create(
      { body: longBody('seedB'), folderId: folderB.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: seedB.id, clusterId: 'payments-ledger', source: 'tier1' });

    // Two fresh notes per folder enqueued for Tier 1 — we expect the
    // resolver to be hit ONCE per folder (memoised), not per row.
    const enqueueFresh = (folderId: string, tag: string) => {
      const n = ctx.notes.create(
        { body: longBody(tag), folderId, source: 'user' },
        'user',
      );
      ctx.metadataQueue.enqueue(folderId, n.id, 'tier1', hashBody(longBody(tag)));
      return n;
    };
    enqueueFresh(folderA.id, 'A1');
    enqueueFresh(folderA.id, 'A2');
    enqueueFresh(folderB.id, 'B1');
    enqueueFresh(folderB.id, 'B2');

    const resolverCalls: string[] = [];
    const cache = new Map<string, string[]>();
    const knownClustersFor = (folderId: string): string[] => {
      resolverCalls.push(folderId);
      let cached = cache.get(folderId);
      if (!cached) {
        cached = ctx.clusters.listClusterIdsForFolder(folderId);
        cache.set(folderId, cached);
      }
      return cached;
    };

    const provider = new StubProvider(async (r) => okResponse(r.model));
    await drainTier1Queue(
      {
        db: ctx.handle.db,
        notes: ctx.notes,
        metaRepo: ctx.meta,
        clustersRepo: ctx.clusters,
        metadataQueue: ctx.metadataQueue,
        clusterQueue: ctx.clusterQueue,
        provider,
        model: 'm',
      },
      { knownClustersFor, concurrency: 4 },
    );

    // Resolver was called per row (4 rows = 4 calls), but the cache
    // collapses the underlying repo lookups — that's the contract.
    expect(resolverCalls.length).toBe(4);
    expect(resolverCalls.filter((id) => id === folderA.id)).toHaveLength(2);
    expect(resolverCalls.filter((id) => id === folderB.id)).toHaveLength(2);

    // Every Tier 1 call's system prompt MUST contain the "Known cluster
    // ids" preamble (i.e. the populated branch of buildTier1Messages),
    // and MUST cite ONLY the cluster ids of THAT call's folder — no
    // cross-folder leak.
    for (const call of provider.calls) {
      const system = call.messages.find((m) => m.role === 'system');
      expect(system).toBeTruthy();
      const sysContent =
        typeof system!.content === 'string'
          ? system!.content
          : JSON.stringify(system!.content);
      expect(sysContent).toContain('Known cluster ids');
      const userMsg = call.messages.find((m) => m.role === 'user');
      const userContent =
        typeof userMsg!.content === 'string'
          ? userMsg!.content
          : JSON.stringify(userMsg!.content);
      const isAFolderNote = userContent.includes('Tag=A1') || userContent.includes('Tag=A2');
      const isBFolderNote = userContent.includes('Tag=B1') || userContent.includes('Tag=B2');
      if (isAFolderNote) {
        expect(sysContent).toContain('flux-handlers');
        expect(sysContent).toContain('webhook-router');
        expect(sysContent).not.toContain('payments-ledger');
      }
      if (isBFolderNote) {
        expect(sysContent).toContain('payments-ledger');
        expect(sysContent).not.toContain('flux-handlers');
        expect(sysContent).not.toContain('webhook-router');
      }
    }
  });

  it('takes the empty-folder prompt branch when knownClustersFor is omitted', async () => {
    // Documents the legacy / opt-out behaviour — without a resolver the
    // worker shouldn't crash, the prompt just falls back to "propose new".
    // Note: the fallback prompt template cites `kanban-ui` and
    // `mo-chat-loop` as kebab-case examples, so the assertion uses a
    // distinct slug (`zilch-witness`) that's guaranteed not to appear
    // in either branch's static text.
    const folder = ctx.folders.create('F');
    const seed = ctx.notes.create(
      { body: longBody('seed'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.clusters.upsert({ noteId: seed.id, clusterId: 'zilch-witness', source: 'tier1' });

    const fresh = ctx.notes.create(
      { body: longBody('fresh'), folderId: folder.id, source: 'user' },
      'user',
    );
    ctx.metadataQueue.enqueue(folder.id, fresh.id, 'tier1', hashBody(longBody('fresh')));

    const provider = new StubProvider(async (r) => okResponse(r.model));
    await drainTier1Queue({
      db: ctx.handle.db,
      notes: ctx.notes,
      metaRepo: ctx.meta,
      clustersRepo: ctx.clusters,
      metadataQueue: ctx.metadataQueue,
      clusterQueue: ctx.clusterQueue,
      provider,
      model: 'm',
    });

    expect(provider.calls.length).toBe(1);
    const system = provider.calls[0].messages.find((m) => m.role === 'system');
    const sysContent =
      typeof system!.content === 'string'
        ? system!.content
        : JSON.stringify(system!.content);
    // Legacy branch: model is told the folder is empty and is asked to
    // propose new ids. Existing clusters are NOT mentioned.
    expect(sysContent).toContain('No clusters exist');
    expect(sysContent).not.toContain('zilch-witness');
  });
});

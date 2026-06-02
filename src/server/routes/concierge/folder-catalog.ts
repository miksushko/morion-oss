/**
 * Project Summary + reindex + topic-cleanup + regenerate-catalog
 * routes (Phase 6.7 / 6.8 / Topic Hygiene engine).
 *
 * - GET    /folders/:id/catalog               — read parsed catalog sections.
 * - PATCH  /folders/:id/catalog               — write user edits to anchored sections.
 * - POST   /folders/:id/reindex-all           — re-enqueue every folder note for Tier 1.
 * - POST   /folders/:id/topic-cleanup         — run one hygiene pass NOW.
 * - GET    /folders/:id/topic-cleanup         — last-run + decisions summary.
 * - POST   /folders/:id/regenerate-catalog    — force runTier25ForFolder.
 *
 * Mutation handlers are Pro-gated. The hygiene + regen-catalog
 * handlers also gate on the MoIndexing provider being configured
 * (OpenRouter with a key) and 501 when the relevant repository is
 * missing from the concierge bag (legacy / test contexts).
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 5/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import { parseCatalogDoc } from '../../../core/concierge/mo-catalog-doc.js';
import { findCatalogNoteId } from '../../../core/concierge/mo-tier25.js';
import { resolveMoIndexingProvider } from '../../features/concierge-deps/index.js';
import type { ToolContext } from '../../tools/types.js';
import { asHost, requireConciergeDeps } from './shared.js';

export function registerFolderCatalogRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  // ------- User edits to catalog sections (Phase 6.7 v2) --------------
  // Accepts a partial `{sections: {overview?, clusters?, recent?,
  // risks?}}` payload. Renders the new section(s) into the catalog
  // note's body via the same anchored markers Tier 2.5 uses; user
  // prose outside anchors is preserved byte-for-byte. Lazily creates
  // the catalog note if one doesn't exist yet — gives the user a
  // working write target before Mo's first index pass.
  app.patch('/api/concierge/folders/:id/catalog', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    const folder = ctx.folders.getById(folderId);
    if (!folder) return c.json({ error: 'folder_not_found' }, 404);

    const sectionsSchema = z
      .object({
        overview: z.string().max(20_000).optional(),
        clusters: z.string().max(20_000).optional(),
        recent: z.string().max(20_000).optional(),
        risks: z.string().max(20_000).optional(),
      })
      .strict();
    const patchSchema = z.object({ sections: sectionsSchema });
    const patch = patchSchema.parse(await c.req.json());

    const { ensureCatalogNote } = await import(
      '../../../core/concierge/mo-tier25.js'
    );
    const { mergeCatalogDoc, renderSection: renderCatalogSection } =
      await import('../../../core/concierge/mo-catalog-doc.js');

    const ensured = ensureCatalogNote(ctx.db, folderId, folder.name);
    // Build a synthetic LLM-shape "response" carrying ONLY the user's
    // edited sections so mergeCatalogDoc preserves every untouched
    // section. Order doesn't matter — merge keys section-by-section.
    const fragments: string[] = [];
    if (patch.sections.overview !== undefined) {
      fragments.push(renderCatalogSection('overview', patch.sections.overview));
    }
    if (patch.sections.clusters !== undefined) {
      fragments.push(renderCatalogSection('clusters', patch.sections.clusters));
    }
    if (patch.sections.recent !== undefined) {
      fragments.push(renderCatalogSection('recent', patch.sections.recent));
    }
    if (patch.sections.risks !== undefined) {
      fragments.push(renderCatalogSection('risks', patch.sections.risks));
    }
    const merged = mergeCatalogDoc(
      ensured.body,
      fragments.join('\n\n'),
      folder.name,
    );
    ctx.db
      .prepare('UPDATE notes SET body = ?, updated_at = ? WHERE id = ?')
      .run(merged, Date.now(), ensured.id);

    const note = ctx.notes.getById(ensured.id);
    const parsed = parseCatalogDoc(note?.body ?? merged);
    return c.json({
      folderId,
      catalogNoteId: ensured.id,
      body: note?.body ?? merged,
      sections: parsed.sections,
      updatedAt: note?.updatedAt ?? Date.now(),
    });
  });

  // ------- Manual full-folder re-index (Phase 6.8 self-recovery) ------
  // Enqueue every non-archived note in a folder for Tier 1, regardless
  // of whether it has fresh audit_log activity. Used by:
  //   - Power user "Re-index this folder" flow (UI button TBD)
  //   - Recovery from a stuck pipeline (app crashed mid-LLM, queue
  //     drained partially, some notes never made it through)
  //   - First indexing of an old folder whose notes haven't been
  //     edited since the last `audit_log` checkpoint advanced past them
  //
  // Pro-gated because it can spike cloud spend (one Tier 1 LLM call
  // per note + downstream Tier 2 + 2.5). Returns the count of
  // enqueued rows so the caller can show "queued N notes" feedback.
  app.post('/api/concierge/folders/:id/reindex-all', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    const metaQueue = ctx.concierge?.moMetadataQueue;
    if (!metaQueue) {
      return c.json({ error: 'mo_internal_not_wired' }, 501);
    }
    const { hashBody } = await import('../../../core/concierge/mo-tier1.js');
    // Pull every user-visible note in the folder (mo:* system notes
    // already excluded by the default list filter — they don't get
    // re-indexed; they ARE the indices).
    const notes = ctx.notes.list({
      folderId,
      limit: 5000,
      offset: 0,
    });
    let enqueued = 0;
    for (const note of notes) {
      metaQueue.enqueue(folderId, note.id, 'tier1', hashBody(note.body));
      enqueued++;
    }
    return c.json({ folderId, enqueued });
  });

  // ------- Topic cleanup (Mo Indexing dedup engine) -------------------
  // POST: run one hygiene pass NOW. Pulls cluster panorama, asks the
  // proposer model for merge / demote candidates, auto-applies high-
  // confidence ones via mergeClusters, opens ONE Ask Mo session for
  // the rest. Records last-run timestamp in workspace settings so the
  // UI can surface "last run X ago".
  // GET: read-only summary — last run timestamp + recent decisions
  // for this folder. Drives the UI indicator + decisions list.
  //
  // 4h scheduler firing layers on top of POST in a follow-up; this
  // route is the user-facing "Run topic cleanup now" entrypoint.
  app.post('/api/concierge/folders/:id/topic-cleanup', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    if (!ctx.concierge?.moClusters || !ctx.concierge?.moClusterQueue) {
      return c.json({ error: 'mo_internal_not_wired' }, 501);
    }
    if (!ctx.concierge?.moTopicDecisions) {
      return c.json({ error: 'mo_topic_decisions_not_wired' }, 501);
    }
    const provider = resolveMoIndexingProvider(asHost(ctx));
    if (!provider) {
      return c.json(
        {
          error: 'mo_backend_not_openrouter',
          message:
            'Topic cleanup requires OpenRouter as the active backend with a configured key.',
        },
        400,
      );
    }
    const folderSettings = bag.bag.folderSettings.getOrDefault(folderId);

    const { runTopicHygiene, TOPIC_HYGIENE_LAST_RUN_AT } = await import(
      '../../../core/concierge/index.js'
    );
    const result = await runTopicHygiene(
      {
        db: ctx.db,
        clusters: ctx.concierge.moClusters,
        clusterQueue: ctx.concierge.moClusterQueue,
        decisions: ctx.concierge.moTopicDecisions,
        sessions: ctx.concierge.sessions,
        messages: ctx.concierge.messages,
        provider: provider.provider,
        budget: ctx.concierge.budget,
        model: provider.topicHygieneModel,
        fallbackModel: provider.topicHygieneFallbackModel,
      },
      folderId,
      { topicExclusions: folderSettings.topicExclusions ?? '' },
    );
    if (result.status === 'ok' || result.status === 'skipped') {
      // Record the run timestamp on every non-error outcome so the UI
      // shows "X minutes ago" even when the pass found nothing.
      ctx.settings.set(TOPIC_HYGIENE_LAST_RUN_AT(folderId), Date.now());
    }
    return c.json(result);
  });

  app.get('/api/concierge/folders/:id/topic-cleanup', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    if (!ctx.concierge?.moTopicDecisions) {
      return c.json({ error: 'mo_topic_decisions_not_wired' }, 501);
    }
    const { TOPIC_HYGIENE_LAST_RUN_AT } = await import(
      '../../../core/concierge/index.js'
    );
    const lastRunAt = ctx.settings.get<number>(
      TOPIC_HYGIENE_LAST_RUN_AT(folderId),
      0,
    );
    const decisions = ctx.concierge.moTopicDecisions.listForFolder(folderId);
    return c.json({
      folderId,
      lastRunAt: lastRunAt > 0 ? lastRunAt : null,
      decisions,
    });
  });

  // ------- Manual catalog regen (Phase 6.7) ---------------------------
  // Force-fires runTier25ForFolder for one folder, ignoring debounce.
  // Used by the "Refresh project summary" button on the Project
  // Summary tab and by the e2e smoke harness. Pro-gated.
  app.post('/api/concierge/folders/:id/regenerate-catalog', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    if (!ctx.concierge?.moMetadata || !ctx.concierge?.moClusters) {
      return c.json({ error: 'mo_internal_not_wired' }, 501);
    }
    const provider = resolveMoIndexingProvider(asHost(ctx));
    if (!provider) {
      return c.json(
        {
          error: 'mo_backend_not_openrouter',
          message:
            'Mo metadata indexing requires OpenRouter as the active backend with a configured key.',
        },
        400,
      );
    }
    const { runTier25ForFolder } = await import(
      '../../../core/concierge/mo-tier25.js'
    );
    const result = await runTier25ForFolder(
      {
        db: ctx.db,
        notes: ctx.notes,
        folders: ctx.folders,
        metaRepo: ctx.concierge.moMetadata,
        clustersRepo: ctx.concierge.moClusters,
        provider: provider.provider,
        budget: ctx.concierge.budget,
        model: provider.tier2Model,
        fallbackModel: provider.tier2FallbackModel,
      },
      folderId,
    );
    return c.json({ folderId, ...result });
  });

  // ------- Project Summary / Catalog (Phase 6.7) ----------------------
  // Per-folder catalog body backing the new Project Summary tab.
  // Returns the underlying mo:catalog note id (so the UI can offer an
  // "open the full note" affordance) plus the parsed sections so the
  // tab can render them as separate editable surfaces.
  app.get('/api/concierge/folders/:id/catalog', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    const catalogId = findCatalogNoteId(ctx.db, folderId);
    if (!catalogId) {
      return c.json({
        folderId,
        catalogNoteId: null,
        body: null,
        sections: null,
        updatedAt: null,
      });
    }
    const note = ctx.notes.getById(catalogId);
    if (!note) {
      return c.json({
        folderId,
        catalogNoteId: null,
        body: null,
        sections: null,
        updatedAt: null,
      });
    }
    const parsed = parseCatalogDoc(note.body);
    return c.json({
      folderId,
      catalogNoteId: note.id,
      body: note.body,
      sections: {
        overview: parsed.sections.overview,
        clusters: parsed.sections.clusters,
        recent: parsed.sections.recent,
        risks: parsed.sections.risks,
      },
      updatedAt: note.updatedAt,
    });
  });
}

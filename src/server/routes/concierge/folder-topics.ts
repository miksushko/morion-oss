/**
 * Tasks Topics tab routes (Phase 6.2 / 6.8).
 *
 * - GET   /folders/:id/topics                       — list per-folder clusters.
 * - POST  /folders/:id/topics                       — create a new topic by name.
 * - GET   /folders/:id/topics/:clusterId            — full cluster aggregator note.
 * - PATCH /folders/:id/topics/:clusterId            — write user edits to cluster sections.
 * - POST  /folders/:id/topics/:clusterId/regenerate — force runTier2ForCluster.
 *
 * Master-detail UI: list view runs off `note_mo_clusters` JOIN
 * `notes` (filtered to user-visible non-archived). Detail view reads
 * the `mo:cluster:<slug>` aggregator note and renders parsed
 * sections (overview / state / open / notes). Writes go through
 * `mergeClusterDoc` so anchored Tier 2 sections + user prose
 * outside anchors both survive byte-for-byte.
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 5/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import { parseClusterDoc } from '../../../core/concierge/mo-cluster-doc.js';
import {
  findClusterNoteId,
  runTier2ForCluster,
} from '../../../core/concierge/mo-tier2.js';
import { resolveMoIndexingProvider } from '../../features/concierge-deps/index.js';
import type { ToolContext } from '../../tools/types.js';
import { asHost, requireConciergeDeps, slugifyTopicName } from './shared.js';

const clusterSectionsSchema = z
  .object({
    overview: z.string().max(20_000).optional(),
    state: z.string().max(20_000).optional(),
    open: z.string().max(20_000).optional(),
    notes: z.string().max(20_000).optional(),
  })
  .strict();
const clusterPatchSchema = z.object({ sections: clusterSectionsSchema });

export function registerFolderTopicsRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  // Per-folder cluster list backing the Tasks Topics tab. Reads
  // `note_mo_clusters` rows scoped to the folder's notes, groups by
  // cluster_id, and joins each cluster id against its mo:cluster:<id>
  // aggregator note (if Tier 2 has run). Suggested-but-not-yet-promoted
  // clusters appear with `summary: null` — Tier 1 wrote the
  // assignments but Tier 2.5 hasn't built the description yet.
  app.get('/api/concierge/folders/:id/topics', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    interface Row {
      cluster_id: string;
      note_count: number;
      max_confidence: number;
      sources: string;
      updated_at: number;
    }
    const rows = ctx.db
      .prepare<[string], Row>(
        `SELECT
            nc.cluster_id        AS cluster_id,
            COUNT(*)             AS note_count,
            MAX(nc.confidence)   AS max_confidence,
            GROUP_CONCAT(DISTINCT nc.source) AS sources,
            MAX(nc.updated_at)   AS updated_at
         FROM note_mo_clusters nc
         JOIN notes n ON n.id = nc.note_id
         WHERE n.folder_id = ?
           AND n.deleted_at IS NULL
           AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
         GROUP BY nc.cluster_id
         ORDER BY note_count DESC, nc.cluster_id ASC`,
      )
      .all(folderId);
    const topics = rows.map((row) => {
      const clusterNoteId = findClusterNoteId(ctx.db, folderId, row.cluster_id);
      const clusterNote = clusterNoteId ? ctx.notes.getById(clusterNoteId) : null;
      const sourcesArr = row.sources ? row.sources.split(',') : [];
      const userPromoted = sourcesArr.includes('user');
      // Pull the Tier 2 `overview` section as the summary preview.
      // Phase 6.2 user direction: clusters Tier 1 emitted but Tier 2
      // hasn't fired on yet show with summary=null and the UI renders
      // a "Mo will summarise on next index" placeholder.
      let summary: string | null = null;
      if (clusterNote?.body) {
        const parsed = parseClusterDoc(clusterNote.body);
        const overview = parsed.sections.overview?.trim() ?? '';
        if (overview && !overview.startsWith('_')) {
          summary = overview.slice(0, 320);
        }
      }
      return {
        clusterId: row.cluster_id,
        noteCount: row.note_count,
        maxConfidence: row.max_confidence,
        sources: sourcesArr,
        userPromoted,
        clusterNoteId,
        summary,
        updatedAt: row.updated_at,
      };
    });
    return c.json({ folderId, topics });
  });

  // POST /api/concierge/folders/:id/topics (Phase 6.8)
  // Create a new topic by name. Slug = lowercase / non-alphanumeric
  // collapsed to `-`, enforced to match the backend ANCHORED_SECTION_RE
  // charset (`[a-z][a-z0-9_-]*`). Lazy-creates the mo:cluster:<slug>
  // aggregator note via ensureClusterNote so the editor pane has a
  // write target immediately. Tier 2 will fill in the auto sections
  // on the next indexing pass once notes get assigned to the cluster.
  app.post('/api/concierge/folders/:id/topics', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    const body = z
      .object({ name: z.string().min(1).max(120) })
      .parse(await c.req.json());
    const slug = slugifyTopicName(body.name);
    if (!slug) {
      return c.json(
        {
          error: 'invalid_topic_name',
          message:
            'Topic name must contain at least one alphanumeric character.',
        },
        400,
      );
    }
    const { ensureClusterNote } = await import(
      '../../../core/concierge/mo-tier2.js'
    );
    const ensured = ensureClusterNote(ctx.db, folderId, slug);
    return c.json(
      { folderId, clusterId: slug, clusterNoteId: ensured.id },
      201,
    );
  });

  // GET /api/concierge/folders/:id/topics/:clusterId — full cluster
  // aggregator note (id, body, parsed sections) backing inline editing
  // on the Tasks Topics tab.
  app.get('/api/concierge/folders/:id/topics/:clusterId', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    const clusterId = c.req.param('clusterId');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    const noteId = findClusterNoteId(ctx.db, folderId, clusterId);
    if (!noteId) {
      return c.json({
        folderId,
        clusterId,
        clusterNoteId: null,
        body: null,
        sections: null,
        updatedAt: null,
      });
    }
    const note = ctx.notes.getById(noteId);
    if (!note) {
      return c.json({
        folderId,
        clusterId,
        clusterNoteId: null,
        body: null,
        sections: null,
        updatedAt: null,
      });
    }
    const parsed = parseClusterDoc(note.body);
    return c.json({
      folderId,
      clusterId,
      clusterNoteId: note.id,
      body: note.body,
      sections: parsed.sections,
      updatedAt: note.updatedAt,
    });
  });

  // PATCH /api/concierge/folders/:id/topics/:clusterId — accept
  // partial `{sections: {overview?, state?, open?, notes?}}`. Lazy-
  // creates the aggregator note when absent so the UI has a write
  // target before Tier 2 has fired. Merges via the same anchored-
  // section format Tier 2 uses; user prose outside anchors is
  // preserved byte-for-byte.
  app.patch('/api/concierge/folders/:id/topics/:clusterId', async (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    const clusterId = c.req.param('clusterId');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    const patch = clusterPatchSchema.parse(await c.req.json());
    const { ensureClusterNote } = await import(
      '../../../core/concierge/mo-tier2.js'
    );
    const { mergeClusterDoc, renderSection } = await import(
      '../../../core/concierge/mo-cluster-doc.js'
    );
    const ensured = ensureClusterNote(ctx.db, folderId, clusterId);
    const fragments: string[] = [];
    if (patch.sections.overview !== undefined) {
      fragments.push(renderSection('overview', patch.sections.overview));
    }
    if (patch.sections.state !== undefined) {
      fragments.push(renderSection('state', patch.sections.state));
    }
    if (patch.sections.open !== undefined) {
      fragments.push(renderSection('open', patch.sections.open));
    }
    if (patch.sections.notes !== undefined) {
      fragments.push(renderSection('notes', patch.sections.notes));
    }
    const merged = mergeClusterDoc(
      ensured.body,
      fragments.join('\n\n'),
      clusterId,
    );
    ctx.db
      .prepare('UPDATE notes SET body = ?, updated_at = ? WHERE id = ?')
      .run(merged, Date.now(), ensured.id);
    const note = ctx.notes.getById(ensured.id);
    const parsed = parseClusterDoc(note?.body ?? merged);
    return c.json({
      folderId,
      clusterId,
      clusterNoteId: ensured.id,
      body: note?.body ?? merged,
      sections: parsed.sections,
      updatedAt: note?.updatedAt ?? Date.now(),
    });
  });

  // Force-regenerate a cluster aggregator. Mirror of `mo_regenerate_cluster`
  // MCP tool — UI calls this directly from the Tasks Topics tab "Refresh"
  // button, bypassing the chat-tier intermediary.
  app.post(
    '/api/concierge/folders/:id/topics/:clusterId/regenerate',
    async (c) => {
      const bag = requireConciergeDeps(ctx);
      if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
      const folderId = c.req.param('id');
      const clusterId = c.req.param('clusterId');
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
      const result = await runTier2ForCluster(
        {
          db: ctx.db,
          notes: ctx.notes,
          metaRepo: ctx.concierge.moMetadata,
          clustersRepo: ctx.concierge.moClusters,
          provider: provider.provider,
          budget: ctx.concierge.budget,
          model: provider.tier2Model,
          fallbackModel: provider.tier2FallbackModel,
        },
        folderId,
        clusterId,
        { force: true },
      );
      return c.json({ folderId, clusterId, ...result });
    },
  );
}

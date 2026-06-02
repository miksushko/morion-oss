import type { Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../../tools/types.js';

/**
 * Per-note Mo metadata (Phase 6.5) and cluster reassignment routes.
 * Backed by `note_mo_metadata` (LLM-tier summary, keywords,
 * computed_by, confidence + the user-toggleable `mo_hands_off` flag)
 * and `note_mo_clusters` (many-to-many cluster assignments). The UI
 * edits only the user-owned fields here — Mo-owned fields stay
 * read-only on the wire and are written exclusively by the indexing
 * pipeline.
 *
 * Routes:
 *   - `GET    /api/notes/:id/metadata`  — metadata + cluster rows
 *   - `PATCH  /api/notes/:id/metadata`  — Pro-gated user overrides
 *   - `PUT    /api/notes/:id/clusters`  — Pro-gated cluster reassign
 *
 * Extracted from src/server/routes/notes.ts during the 2026-05-16
 * split (Morion ticket 01KRR8J8ED8E8QE37W3QRBP8G7).
 */
export function registerNotesMetadataRoutes(app: Hono, ctx: ToolContext): void {
  app.get('/api/notes/:id/metadata', (c) => {
    const noteId = c.req.param('id');
    const note = ctx.notes.getById(noteId);
    if (!note) return c.json({ error: 'not_found' }, 404);
    const metaRepo = ctx.concierge?.moMetadata;
    const clustersRepo = ctx.concierge?.moClusters;
    if (!metaRepo || !clustersRepo) {
      return c.json({ error: 'mo_internal_not_wired' }, 501);
    }
    const meta = metaRepo.get(noteId);
    const clusters = clustersRepo.listForNote(noteId);
    return c.json({
      noteId,
      metadata: meta,
      clusters,
    });
  });

  // Phase 6.7 — relaxed schema. The user can override every Mo-owned
  // metadata field from the Meta Data tab; once they do, the row is
  // tagged `computedBy='user'` and the indexing pipeline treats it as
  // a user override (Mo's merge logic preserves user-edited content
  // across regens — see CLAUDE.md "Human text is sacred" invariant).
  const metadataPatchSchema = z
    .object({
      summary: z.string().max(8_000).optional(),
      keywords: z.array(z.string().min(1).max(120)).max(40).optional(),
      moHandsOff: z.boolean().optional(),
    })
    .strict();

  app.patch('/api/notes/:id/metadata', async (c) => {
    const noteId = c.req.param('id');
    const note = ctx.notes.getById(noteId);
    if (!note) return c.json({ error: 'not_found' }, 404);
    const metaRepo = ctx.concierge?.moMetadata;
    const clustersRepo = ctx.concierge?.moClusters;
    if (!metaRepo || !clustersRepo) {
      return c.json({ error: 'mo_internal_not_wired' }, 501);
    }
    const patch = metadataPatchSchema.parse(await c.req.json());
    if (typeof patch.moHandsOff === 'boolean') {
      metaRepo.setHandsOff(noteId, patch.moHandsOff);
    }
    // User-edited summary / keywords land via upsert with
    // computedBy='user'. The merge keeps unspecified fields intact
    // so a partial PATCH only touches what the UI sent.
    if (patch.summary !== undefined || patch.keywords !== undefined) {
      const existing = metaRepo.get(noteId);
      metaRepo.upsert({
        noteId,
        summary: patch.summary ?? existing?.summary ?? '',
        keywords: patch.keywords ?? existing?.keywords ?? [],
        bodyHash: existing?.bodyHash ?? null,
        computedBy: 'user',
        computedAt: Date.now(),
        confidence: 1.0,
      });
    }
    const meta = metaRepo.get(noteId);
    const clusters = clustersRepo.listForNote(noteId);
    return c.json({ noteId, metadata: meta, clusters });
  });

  // PUT a fresh cluster set tagged source='user'. Mirrors the
  // `mo_reclassify` MCP tool semantics: replaceForNote with
  // preserveUserOverrides=false (a user PUT IS the new source of
  // truth), then enqueue every touched cluster id (old + new) for
  // Tier 2 regen so the affected aggregator notes refresh.
  const clustersPutSchema = z.object({
    clusters: z.array(z.string().min(1).max(120)).max(20),
  });

  app.put('/api/notes/:id/clusters', async (c) => {
    const noteId = c.req.param('id');
    const note = ctx.notes.getById(noteId);
    if (!note) return c.json({ error: 'not_found' }, 404);
    const clustersRepo = ctx.concierge?.moClusters;
    const clusterQueue = ctx.concierge?.moClusterQueue;
    if (!clustersRepo) {
      return c.json({ error: 'mo_internal_not_wired' }, 501);
    }
    const patch = clustersPutSchema.parse(await c.req.json());
    const before = new Set(
      clustersRepo.listForNote(noteId).map((r) => r.clusterId),
    );
    const next = clustersRepo.replaceForNote(
      noteId,
      patch.clusters.map((clusterId) => ({
        clusterId,
        source: 'user' as const,
      })),
      { preserveUserOverrides: false },
    );
    const after = new Set(next.map((r) => r.clusterId));
    if (clusterQueue && note.folderId) {
      const touched = new Set<string>([...before, ...after]);
      for (const clusterId of touched) {
        clusterQueue.enqueue(note.folderId, clusterId);
      }
    }
    return c.json({ noteId, clusters: next });
  });
}

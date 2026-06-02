/**
 * Per-folder Risks + Logs tabs (Phase 6.4).
 *
 * GET /api/concierge/folders/:id/risks — catalog risks section +
 *   open p0/p1 findings from `mo_patrol_findings`.
 * GET /api/concierge/folders/:id/logs — patrol log note body +
 *   open findings + last 50 resolved findings.
 *
 * Read-only, no Pro gate (UI surfaces work for Free users too — they
 * just see the empty state).
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 4/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import { parseCatalogDoc } from '../../../core/concierge/mo-catalog-doc.js';
import { findCatalogNoteId } from '../../../core/concierge/mo-tier25.js';
import { findPatrolLogNote } from '../../../core/concierge/mo-patrol-log.js';
import type { ToolContext } from '../../tools/types.js';
import { requireConciergeDeps, serializeFinding } from './shared.js';

export function registerFolderRisksLogsRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  // Risks tab. Two groups: catalog risks section (Tier 2.5 narrative)
  // + open Tier 0 p0/p1 findings from `mo_patrol_findings`.
  app.get('/api/concierge/folders/:id/risks', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }

    // Catalog risks section — null when no Tier 2.5 has run for this folder.
    let catalogRisks: string | null = null;
    let catalogNoteId: string | null = null;
    let catalogUpdatedAt: number | null = null;
    const cId = findCatalogNoteId(ctx.db, folderId);
    if (cId) {
      const note = ctx.notes.getById(cId);
      if (note?.body) {
        const parsed = parseCatalogDoc(note.body);
        const r = parsed.sections.risks?.trim() ?? '';
        // Skip placeholder copy ("_No risks identified yet._").
        if (r && !(r.startsWith('_') && r.endsWith('_'))) {
          catalogRisks = r;
        }
        catalogNoteId = note.id;
        catalogUpdatedAt = note.updatedAt;
      }
    }

    // Tier 0 high-severity open findings — null repo on legacy bags.
    const findingsRepo = ctx.concierge?.moPatrolFindings;
    const allOpen = findingsRepo ? findingsRepo.listOpen(folderId) : [];
    const highSev = allOpen
      .filter((f) => f.severity === 'p0' || f.severity === 'p1')
      .map((f) => ({
        id: f.id,
        kind: f.findingKind,
        severity: f.severity,
        message: f.message,
        noteId: f.noteId,
        context: f.context,
        createdAt: f.createdAt,
      }));

    return c.json({
      folderId,
      catalog: {
        noteId: catalogNoteId,
        risks: catalogRisks,
        updatedAt: catalogUpdatedAt,
      },
      findings: highSev,
    });
  });

  // Logs tab. Three groups: patrol-log note body + open findings +
  // last 50 resolved findings.
  app.get('/api/concierge/folders/:id/logs', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }

    let patrolLogNoteId: string | null = null;
    let patrolLogBody: string | null = null;
    let patrolLogUpdatedAt: number | null = null;
    const row = findPatrolLogNote(ctx.db, folderId);
    if (row) {
      patrolLogNoteId = row.id;
      patrolLogBody = row.body;
      patrolLogUpdatedAt = row.updated_at;
    }

    const findingsRepo = ctx.concierge?.moPatrolFindings;
    const openFindings = findingsRepo
      ? findingsRepo.listOpen(folderId).map(serializeFinding)
      : [];
    const allFindings = findingsRepo ? findingsRepo.listAll(folderId) : [];
    const resolvedFindings = allFindings
      .filter(
        (f) =>
          f.state === 'accepted' ||
          f.state === 'dismissed' ||
          (f.state === 'snoozed' &&
            f.snoozeUntil != null &&
            f.snoozeUntil > Date.now()),
      )
      .slice(0, 50)
      .map(serializeFinding);

    return c.json({
      folderId,
      patrolLog: {
        noteId: patrolLogNoteId,
        body: patrolLogBody,
        updatedAt: patrolLogUpdatedAt,
      },
      openFindings,
      resolvedFindings,
    });
  });
}

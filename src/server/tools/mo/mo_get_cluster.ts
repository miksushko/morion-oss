import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import {
  requireMoEnabledForFolder,
} from './gate.js';
import { findClusterNoteId } from '../../../core/concierge/index.js';

/**
 * Phase 6 primitive — context restructure ticket
 * `01KQFQ1RJV7EH0X3WF2H1A476J`.
 *
 * Read ONE cluster's aggregator doc body + the metadata of every note
 * assigned to that cluster (id + title + summary + keywords). No LLM
 * call. Designed for the deep-context-gather Wave 1 task-cluster-
 * analyst sub-Mo: it gets the aggregator doc + per-task metas in one
 * scoped read instead of N+1 lookups.
 *
 * Bodies are NOT included — caller picks which task ids to drill into
 * (via `notes_get`) based on titles + summaries. That's the cheap-
 * metadata-first contract the whole context restructure rests on.
 */
export const moGetClusterTool = defineTool({
  name: 'mo_get_cluster',
  category: 'read',
  description:
    "Read ONE cluster's aggregator doc body + every assigned note's metadata (id, title, summary, keywords). NO bodies — caller decides which to drill into via notes_get. Cheap deterministic SQL + at most one note read for the aggregator. Requires the folder to have Mo enabled.",
  inputShape: {
    folderId: z
      .string()
      .min(1)
      .describe('Morion folder id the cluster lives in.'),
    clusterId: z
      .string()
      .min(1)
      .describe(
        'Cluster id (e.g. "stripe-webhooks", "kanban-ui"). Use mo_list_clusters to discover available ids.',
      ),
  },
  async handler(input, ctx) {

    const moGate = requireMoEnabledForFolder(ctx, input.folderId);
    if (moGate) return moGate;

    if (!canPerform('read', ctx, { kind: 'folder', folderId: input.folderId })) {
      return ACCESS_DENIED;
    }

    // Aggregator doc body, when present.
    const aggregatorNoteId = findClusterNoteId(
      ctx.db,
      input.folderId,
      input.clusterId,
    );
    let aggregatorBody: string | null = null;
    let aggregatorTitle: string | null = null;
    let aggregatorUpdatedAt: number | null = null;
    if (aggregatorNoteId) {
      const note = ctx.notes.getById(aggregatorNoteId);
      if (note) {
        aggregatorBody = note.body;
        aggregatorTitle = note.title;
        aggregatorUpdatedAt = note.updatedAt;
      }
    }

    // Assigned-note ids in confidence order. Same `mo:*` exclusion as
    // every other indexing-aware path.
    interface AssignmentRow {
      note_id: string;
      confidence: number;
    }
    const assignments = ctx.db
      .prepare<[string, string], AssignmentRow>(
        `SELECT c.note_id, c.confidence
           FROM note_mo_clusters c
           JOIN notes n ON n.id = c.note_id
          WHERE c.cluster_id = ?
            AND n.folder_id = ?
            AND n.deleted_at IS NULL
            AND (n.source IS NULL OR n.source NOT LIKE 'mo:%')
          ORDER BY c.confidence DESC, c.note_id ASC`,
      )
      .all(input.clusterId, input.folderId);

    const noteIds = assignments.map((a) => a.note_id);
    const metaByNoteId =
      ctx.concierge?.moMetadata?.getMany(noteIds) ?? new Map();

    const tasks = assignments.map((a) => {
      const note = ctx.notes.getById(a.note_id);
      const meta = metaByNoteId.get(a.note_id) ?? null;
      return {
        noteId: a.note_id,
        title: note?.title ?? null,
        status: note?.status ?? null,
        confidence: a.confidence,
        summary: meta?.summary ?? null,
        keywords: meta?.keywords ?? null,
        updatedAt: note?.updatedAt ?? null,
      };
    });

    return {
      folderId: input.folderId,
      clusterId: input.clusterId,
      aggregatorNoteId,
      aggregatorTitle,
      aggregatorBody,
      aggregatorUpdatedAt,
      tasks,
      totalTasks: tasks.length,
      hint:
        tasks.length === 0
          ? 'No notes assigned to this cluster. Either the cluster id is stale or all assigned notes were deleted.'
          : null,
    };
  },
});

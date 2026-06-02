import { z } from 'zod';
import { defineTool } from '../types.js';
import { canPerform, ACCESS_DENIED } from '../../../core/permissions/check.js';
import {
  requireMoEnabledForFolder,
} from './gate.js';
import { toMoInternalCtx } from '../../../core/concierge/index.js';

/**
 * Phase 6 primitive — context restructure ticket
 * `01KQFQ1RJV7EH0X3WF2H1A476J`.
 *
 * Resolve a task id into a structured "everything I know about this
 * task without reading other notes" packet:
 *   - the task's body + folder + status + tags
 *   - cluster assignments + confidence
 *   - Mo metadata (summary + keywords)
 *   - recent comment metadata (id + author + ts + body snippet)
 *   - recent audit history (action + actor + ts)
 *
 * Cheap deterministic — no LLM call. Designed as the bootstrap step
 * for `mo_get_context({taskId})`: all the local-to-the-task context
 * gathered in one round trip before fan-out begins.
 *
 * Mo elevation: the per-note canPerform check uses the elevated
 * `morion-concierge` actor so an archived task is still resolvable
 * (per Phase 3 invariant — Mo is owner-level on reads).
 */
export const moResolveTaskTool = defineTool({
  name: 'mo_resolve_task',
  category: 'read',
  description:
    "Resolve a task id into a structured 'everything Mo knows locally about this task' packet: body + folder + status + tags + cluster assignments + Mo metadata + recent comment metas + recent audit history. NO bodies of other notes — that's mo_get_context's job. Cheap deterministic — no LLM call. Requires the folder to have Mo enabled (resolved from the task's folder).",
  inputShape: {
    taskId: z
      .string()
      .min(1)
      .describe(
        'Morion note ULID for the task you want context on. The task\'s parent folder must have Mo enabled.',
      ),
    commentLimit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Max recent comments returned. Default 20.'),
    auditLimit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Max recent audit rows returned. Default 10.'),
  },
  async handler(input, ctx) {

    // Resolve task → folder so we can apply the per-folder Mo gate.
    // We use elevated context for the read so archived tasks resolve;
    // the gate then runs against the calling actor's view of the
    // folder permission (this is the consistent pattern with mo_search:
    // outer folder gate honoured, internal note reads elevated).
    const moCtx = toMoInternalCtx(ctx);
    const task = ctx.notes.getById(input.taskId, { includeTrashed: true });
    if (!task) {
      return {
        error: 'task_not_found',
        message: `No note found with id ${input.taskId}.`,
      };
    }
    if (task.deletedAt !== null) {
      return {
        error: 'task_deleted',
        message: `Task ${input.taskId} is in trash.`,
      };
    }
    if (!task.folderId) {
      return {
        error: 'task_unfiled',
        message: `Task ${input.taskId} is not in a folder; Mo gates require a parent folder.`,
      };
    }

    const moGate = requireMoEnabledForFolder(ctx, task.folderId);
    if (moGate) return moGate;

    // Per-note read gate via elevated ctx (archive bypass), but the
    // outer folder gate still runs against the calling actor — Mo
    // doesn't override explicit folder visibility decisions.
    if (!canPerform('read', ctx, { kind: 'folder', folderId: task.folderId })) {
      return ACCESS_DENIED;
    }
    if (!canPerform('read', moCtx, { kind: 'note', noteId: input.taskId })) {
      return ACCESS_DENIED;
    }

    const folder = ctx.folders.getById(task.folderId);

    // Cluster assignments + Mo metadata.
    const clusters = ctx.concierge?.moClusters?.listForNote(input.taskId) ?? [];
    const metadata = ctx.concierge?.moMetadata?.get(input.taskId) ?? null;

    // Recent comments (metadata-only — body included since comments
    // are short by design; agents can read in-line).
    const commentLimit = input.commentLimit ?? 20;
    const commentsPage = ctx.comments.list(input.taskId, { limit: commentLimit });
    const comments = commentsPage.items;

    // Recent audit rows for this note. `audit.recent(N)` is workspace-
    // wide; filter to this note id.
    const auditLimit = input.auditLimit ?? 10;
    const allRecent = ctx.audit.recent(200);
    const auditRows = allRecent
      .filter((r) => r.noteId === input.taskId)
      .slice(0, auditLimit);

    return {
      task: {
        id: task.id,
        title: task.title,
        body: task.body,
        folderId: task.folderId,
        status: task.status,
        tags: task.tags,
        pinned: task.pinned,
        archivedAt: task.archivedAt,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      folder: folder
        ? {
            id: folder.id,
            name: folder.name,
            archivedAt: folder.archivedAt,
          }
        : null,
      clusters: clusters.map((c) => ({
        clusterId: c.clusterId,
        confidence: c.confidence,
        source: c.source,
      })),
      metadata: metadata
        ? {
            summary: metadata.summary,
            keywords: metadata.keywords,
            computedBy: metadata.computedBy,
            computedAt: metadata.computedAt,
            confidence: metadata.confidence,
            moHandsOff: metadata.moHandsOff,
          }
        : null,
      comments: comments.map((c) => ({
        id: c.id,
        actor: c.actor,
        body: c.body,
        createdAt: c.createdAt,
      })),
      audit: auditRows.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actor,
        ts: r.timestamp,
      })),
    };
  },
});

import { toMoInternalCtx } from '../../mo-elevate.js';
import { findCatalogNoteId } from '../../mo-tier25.js';
import { hashBody } from '../../mo-tier1.js';
import type { GatherInput, GatherDeps } from '../types.js';
import type { BootstrapState } from './bootstrap-state.js';

/** Cheap hash-only read used for the cache-key calculation BEFORE the
 *  full bootstrap runs. Reads the task body + the folder catalog body
 *  and hashes them. Skipping the full bootstrap on a cache hit saves
 *  the expensive cluster / metadata / comments / audit reads. */
export async function resolveBootstrapKeyParts(
  input: GatherInput,
  deps: GatherDeps,
): Promise<{ taskBodyHash: string | null; folderCatalogHash: string | null }> {
  let taskBodyHash: string | null = null;
  let folderCatalogHash: string | null = null;

  if (input.taskId) {
    const moCtx = toMoInternalCtx(deps.ctx);
    const task = moCtx.notes.getById(input.taskId, { includeTrashed: true });
    if (task) {
      taskBodyHash = hashBody(task.body ?? '');
    }
  }

  if (input.folderId) {
    const catalogId = findCatalogNoteId(deps.ctx.db, input.folderId);
    if (catalogId) {
      const catalog = deps.ctx.notes.getById(catalogId);
      folderCatalogHash = catalog ? hashBody(catalog.body ?? '') : null;
    }
  }

  return { taskBodyHash, folderCatalogHash };
}

/** Full bootstrap read — assembles the `BootstrapState` consumed by
 *  every later wave. Task-mode pulls task body / title / clusters /
 *  metadata / recent comments / per-task audit; folder-mode populates
 *  only `folderCatalogHash`. Returns an empty state when neither
 *  task nor folder resolves on disk.
 *
 *  Uses Mo's elevated ctx (`toMoInternalCtx`) so archived notes /
 *  hidden folders are visible — gather is owner-level on reads per
 *  the Mo elevation contract. */
export async function runBootstrap(
  input: GatherInput,
  deps: GatherDeps,
): Promise<BootstrapState> {
  const moCtx = toMoInternalCtx(deps.ctx);
  const state: BootstrapState = {
    taskId: input.taskId ?? null,
    folderId: input.folderId ?? null,
    taskBodyHash: null,
    folderCatalogHash: null,
    clusterIds: [],
    taskBody: null,
    taskTitle: null,
    metadataSummary: null,
    metadataKeywords: [],
    comments: [],
    audit: [],
  };

  if (input.taskId) {
    const task = moCtx.notes.getById(input.taskId, { includeTrashed: true });
    if (task) {
      state.taskTitle = task.title;
      state.taskBody = task.body ?? '';
      state.taskBodyHash = hashBody(state.taskBody);
      state.folderId = task.folderId ?? state.folderId;

      const clusters =
        moCtx.concierge?.moClusters?.listForNote(input.taskId) ?? [];
      state.clusterIds = clusters.map((c) => c.clusterId);

      const meta = moCtx.concierge?.moMetadata?.get(input.taskId) ?? null;
      if (meta) {
        state.metadataSummary = meta.summary;
        state.metadataKeywords = meta.keywords;
      }

      const commentsPage = moCtx.comments.list(input.taskId, { limit: 20 });
      state.comments = commentsPage.items.map((c) => ({
        actor: c.actor,
        body: c.body,
        createdAt: c.createdAt,
      }));

      const auditRows = moCtx.audit.recent(200);
      state.audit = auditRows
        .filter((r) => r.noteId === input.taskId)
        .slice(0, 10)
        .map((r) => ({ action: r.action, actor: r.actor, ts: r.timestamp }));
    }
  }

  if (state.folderId) {
    const catalogId = findCatalogNoteId(deps.ctx.db, state.folderId);
    if (catalogId) {
      const catalog = deps.ctx.notes.getById(catalogId);
      state.folderCatalogHash = catalog ? hashBody(catalog.body ?? '') : null;
    }
  }

  return state;
}

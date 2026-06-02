/**
 * Per-folder auto-code endpoints.
 *
 * GET  /folders/:id/auto-code/inflight  — pre-toggle-off popup data.
 * POST /folders/:id/auto-code/enqueue   — manual ticket admission.
 * POST /folders/:id/auto-code/tick      — one orchestrator step
 *   (legacy dispatcher only; workflow runner is self-driving).
 * GET  /folders/:id/auto-code/preflight — binary + config check.
 *
 * All four flow through `buildAutoCodeDispatcher(ctx)` which itself
 * picks legacy `mo_agent_queue` vs new `workflow_runs` per the
 * workspace flag.
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 4/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import { runPreflight } from '../../../core/auto-code/preflight.js';
import {
  buildAutoCodeDispatcher,
  inspectFolderWorkflowResolution,
} from '../../features/auto-code-factory/index.js';
import type { ToolContext } from '../../tools/types.js';

export function registerAutoCodeFolderRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  // Auto-code in-flight summary — powers the UI's pre-toggle-off
  // popup. Read-only; no Pro gate (the popup needs to render even
  // when the user's already mid-disable).
  app.get('/api/concierge/folders/:id/auto-code/inflight', async (c) => {
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    // The dispatcher reads BOTH legacy `mo_agent_queue` AND new
    // `workflow_runs` so the popup count is correct regardless of
    // which engine processed prior runs. The dispatcher always
    // returns a usable cancel/inflight surface even when no engine
    // can be wired (legacy queue rows can outlive the engine).
    const dispatcher = await buildAutoCodeDispatcher(ctx);
    return c.json(dispatcher.inflightOverview(folderId));
  });

  // Manual enqueue — explicit entry point for the auto-code loop.
  // Same gates as the audit-log subscriber + scheduler hook.
  app.post('/api/concierge/folders/:id/auto-code/enqueue', async (c) => {
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const taskId = typeof body?.taskId === 'string' ? body.taskId : '';
    if (!taskId) return c.json({ error: 'task_id_required' }, 400);
    const dispatcher = await buildAutoCodeDispatcher(ctx);
    try {
      const result = await dispatcher.enqueueTicket(taskId, folderId);
      if (result.kind === 'rejected' && result.reason === 'auto_code_unavailable') {
        return c.json({ error: 'mo_provider_not_configured', ...result }, 503);
      }
      // Per-call routing in the dispatcher means the actual engine
      // can differ from the workspace flag (Codex P2b round 3,
      // 2026-05-10). The `engine` field on the enqueued result
      // carries the truth; ship it verbatim instead of overriding
      // with `dispatcher.isWorkflowRunner` (which only reflects
      // the global flag).
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: 'enqueue_threw', message: (err as Error).message ?? String(err) },
        500,
      );
    }
  });

  // Manual tick — legacy endpoint retired with the legacy orchestrator
  // (ticket 01KRB0W7CV1PF48YD8FF6J14DG). The workflow runner is self-
  // driving (runner.start dispatches asynchronously), so there's no
  // state-machine step to advance. Kept as a 501 stub so any cached UI
  // client gets a clear error instead of a silent 404.
  app.post('/api/concierge/folders/:id/auto-code/tick', (c) => {
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    return c.json(
      {
        error: 'tick_not_supported',
        message:
          'workflow runner is self-driving; manual tick was a legacy-only endpoint',
      },
      501,
    );
  });

  // Auto-code preflight — folder-id scoped for URL symmetry with the
  // rest of /folders/:id/* (preflight result is workspace-scoped;
  // binaries + configs are global per user). Pro-gated to match the
  // toggle's own gate.
  app.get('/api/concierge/folders/:id/auto-code/preflight', (c) => {
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    return c.json(runPreflight());
  });

  // Workflow-resolution diagnostic — surfaces what the sidecar
  // actually resolves the folder's stored workflow selection to, so
  // the UI can detect mismatches (e.g. the stored row id can't be
  // resolved, or the row got deleted, or it's owned by another
  // folder). Without this the UI shows the dropdown selection as
  // "active" while the runner silently falls back to the default
  // template — Morion ticket 01KRRXB2K744SKJGAZHW6KET93.
  //
  // No Pro gate — the diagnostic is read-only and the UI needs it
  // to render the folder-settings panel before the Pro gate fires.
  app.get('/api/concierge/folders/:id/auto-code/workflow-resolution', (c) => {
    const folderId = c.req.param('id');
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    return c.json(inspectFolderWorkflowResolution(ctx, folderId));
  });
}

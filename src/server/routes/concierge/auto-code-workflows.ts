/**
 * Auto-code workflow templates + custom workflows CRUD.
 *
 * Route shell — handlers are kept inline because they're small (~25
 * LOC each); the chunks that bloated the original 612-LOC file moved
 * to siblings:
 *
 *   - `./auto-code-workflows/legacy-purge.ts` — five-path pre-seed
 *     purge + heal for GET /workflows (~270 LOC)
 *   - `./auto-code-workflows/sticky-delete.ts` — DELETE sticky-delete
 *     provenance bookkeeping (~45 LOC)
 *   - `./auto-code-workflows/templates-route.ts` — GET
 *     /workflow-templates registration (~60 LOC)
 *
 * Endpoints:
 *
 * - GET    /api/auto-code/workflow-templates  — registry-shipped templates
 * - GET    /api/auto-code/workflows           — per-folder custom workflows
 *     + auto-seeded templates as editable rows.
 * - GET    /api/auto-code/workflows/:id       — single workflow lookup.
 * - POST   /api/auto-code/workflows           — create custom workflow.
 * - PUT    /api/auto-code/workflows/:id       — update.
 * - DELETE /api/auto-code/workflows/:id       — delete (clears the active
 *     workflowTemplate setting when it pointed at the deleted row).
 * - POST   /api/auto-code/workflows/:id/clone — copy as "<name> (copy)".
 *
 * Hono trie ordering: `/workflows` list MUST register BEFORE
 * `/workflows/:id`. Pinned by `tests/concierge-route-registration.test.ts`.
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 8/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import {
  DEFAULT_TEMPLATE_ID,
} from '../../../core/auto-code/workflows/templates.js';
import { WorkflowsRepository } from '../../../core/auto-code/workflows/workflows-repository.js';
import {
  folderTemplateSettingKey,
  readFolderWorkflowTemplate,
  writeFolderWorkflowTemplate,
} from '../../features/auto-code-template-settings.js';
import type { ToolContext } from '../../tools/types.js';
import {
  workflowCreateSchema,
  workflowUpdateSchema,
} from './schemas.js';
import {
  alignWorkflowTemplateToSeed,
  purgeLegacyAndHeal,
} from './auto-code-workflows/legacy-purge.js';
import { recordStickyDeleteForRow } from './auto-code-workflows/sticky-delete.js';
import { registerWorkflowTemplatesRoute } from './auto-code-workflows/templates-route.js';

export function registerAutoCodeWorkflowsRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  registerWorkflowTemplatesRoute(app, ctx);

  // ------- Auto-code workflows CRUD (Этап 2) --------------------------
  // Per-folder user-defined workflow definitions. Backed by the
  // `workflows` table (migration 0028); rows are advisory until a
  // folder's `auto_code.workflow_template.<folderId>` setting names
  // one as the active workflow id (resolver handles the registry-vs-
  // DB lookup in `auto-code-factory.ts`). All routes Pro-gated.

  app.get('/api/auto-code/workflows', (c) => {
    const folderId = c.req.query('folderId');
    if (!folderId) return c.json({ error: 'folderId_required' }, 400);
    if (!ctx.folders.getById(folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    // Wrap the entire purge+seed+align+list pipeline in a try/catch
    // so a thrown helper produces a structured 500 envelope (with
    // the failing step + the underlying error) instead of Hono's
    // empty-body crash. The 5-path purge + seed + alignment chain
    // is wide enough that a transient stale module (`tsx watch`
    // hot-reloading mid-refactor — bug 01KRR7VEGNNNE80R4EPABDHATD,
    // 2026-05-16) could throw something cryptic; with this wrapper
    // the next user gets `{error: "auto_code_workflows_failed",
    // step, message}` they can paste into a ticket.
    const trackerKey = `auto_code.seeded_templates.${folderId}`;
    const provenanceKey = `auto_code.seeded_row_provenance.${folderId}`;
    const repo = new WorkflowsRepository(ctx.db);
    let step: 'purge' | 'seed' | 'persist_seed_state' | 'align_template' | 'list_summaries' =
      'purge';
    try {
      const purged = purgeLegacyAndHeal({
        db: ctx.db,
        settings: ctx.settings,
        repo,
        folderId,
      });

      step = 'seed';
      const seedResult = repo.seedDefaultsForFolder(folderId, {
        isSeeded: (id) => purged.seededSet.has(id),
        markSeeded: (id) => purged.seededSet.add(id),
        recordProvenance: (rowId, templateId) => {
          purged.provenance[rowId] = templateId;
        },
      });
      step = 'persist_seed_state';
      ctx.settings.set(trackerKey, Array.from(purged.seededSet).join(','));
      ctx.settings.set(provenanceKey, JSON.stringify(purged.provenance));

      if (seedResult.defaultRowId) {
        step = 'align_template';
        alignWorkflowTemplateToSeed(
          {
            settings: ctx.settings,
            repo,
            folderId,
            folderTemplateSettingKey,
          },
          seedResult.defaultRowId,
        );
      }
      // Slim list — skips per-row Zod walk AND the binary-availability
      // probe. The orchestrator's pre-claim gate is the source of truth
      // on agent availability; popup loads fast and shows errors only
      // when the user actually enqueues.
      step = 'list_summaries';
      const workflows = repo.listSummariesForFolder(folderId);
      return c.json({ workflows });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err ?? 'unknown error');
      // Log with stack so the server console (and `tail morion-serve.log`)
      // shows where the throw came from. Without this the only signal
      // was an opaque 500 in the browser network tab.
      console.error('[auto-code/workflows GET] failed', {
        folderId,
        step,
        error: message,
        stack: err instanceof Error ? err.stack : undefined,
      });
      return c.json(
        {
          error: 'auto_code_workflows_failed',
          step,
          message,
          folderId,
        },
        500,
      );
    }
  });

  app.get('/api/auto-code/workflows/:id', (c) => {
    const repo = new WorkflowsRepository(ctx.db);
    const wf = repo.getById(c.req.param('id'));
    if (!wf) return c.json({ error: 'workflow_not_found' }, 404);
    return c.json(wf);
  });

  app.post('/api/auto-code/workflows', async (c) => {
    const body = workflowCreateSchema.parse(await c.req.json());
    if (!ctx.folders.getById(body.folderId)) {
      return c.json({ error: 'folder_not_found' }, 404);
    }
    const repo = new WorkflowsRepository(ctx.db);
    try {
      const created = repo.create({
        folderId: body.folderId,
        name: body.name,
        definition: body.definition,
        isDefault: body.isDefault,
      });
      // Mirror `is_default=true` onto the folder's
      // `settings.workflowTemplate` so the Folder Settings → Auto-code
      // "Default workflow" dropdown picks up the new row immediately.
      // Without this the two surfaces drift (badge here, dropdown
      // there) — user feedback 2026-05-18.
      if (created.isDefault) {
        writeFolderWorkflowTemplate(
          ctx.settings,
          ctx.db,
          created.folderId,
          created.id,
        );
      }
      return c.json(created, 201);
    } catch (err) {
      // parseLinearWorkflow / Zod failures land here. Surface the
      // message verbatim so the UI's editor can highlight the
      // offending stage / field.
      return c.json(
        {
          error: 'invalid_workflow_definition',
          message: (err as Error).message,
        },
        422,
      );
    }
  });

  app.put('/api/auto-code/workflows/:id', async (c) => {
    const id = c.req.param('id');
    // safeParse so a Zod failure surfaces a USEFUL error to the UI
    // (2026-05-11 user report: they couldn't tell what was wrong
    // with their workflow). Surface first issue verbatim + full
    // issues array for editor highlighting.
    const raw = await c.req.json();
    const parsed = workflowUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const msg = first
        ? `${first.path.join('.') || 'definition'}: ${first.message}`
        : 'invalid_workflow_definition';
      return c.json(
        {
          error: 'invalid_workflow_definition',
          message: msg,
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        422,
      );
    }
    const repo = new WorkflowsRepository(ctx.db);
    try {
      const updated = repo.update(id, parsed.data);
      if (!updated) return c.json({ error: 'workflow_not_found' }, 404);
      // Same sync as the create path — when the user marks this row
      // as the folder's default via the workflow editor, mirror it
      // onto `settings.workflowTemplate` so the Folder Settings
      // dropdown agrees. Skipped on isDefault=false patches so the
      // user can flip is_default off without resetting the
      // dropdown (e.g. clearing badges before picking a new one).
      if (parsed.data.isDefault === true && updated.isDefault) {
        writeFolderWorkflowTemplate(
          ctx.settings,
          ctx.db,
          updated.folderId,
          updated.id,
        );
      }
      return c.json(updated);
    } catch (err) {
      return c.json(
        {
          error: 'invalid_workflow_definition',
          message: (err as Error).message,
        },
        422,
      );
    }
  });

  app.delete('/api/auto-code/workflows/:id', (c) => {
    const id = c.req.param('id');
    const repo = new WorkflowsRepository(ctx.db);
    // Look up before deleting so we know the owner folder for the
    // setting-cleanup step (Codex P1b round 5, 2026-05-10).
    const target = repo.getById(id);
    if (!target) return c.json({ error: 'workflow_not_found' }, 404);
    // Atomically clear the per-folder active-workflow setting when
    // it pointed at this row. Without this the next run would
    // silently fall back to the default template (resolver's
    // safety net) but the UI's "active" badge + dropdown would
    // still display the deleted id, masking the change.
    let clearedFolderId: string | null = null;
    const currentSelection = readFolderWorkflowTemplate(
      ctx.settings,
      target.folderId,
    );
    if (currentSelection === id) {
      writeFolderWorkflowTemplate(
        ctx.settings,
        ctx.db,
        target.folderId,
        DEFAULT_TEMPLATE_ID,
      );
      clearedFolderId = target.folderId;
    }
    // Per-ticket overrides pointing at the deleted row revert to
    // "use folder default" (ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE).
    // Same rationale as the folder-setting clear above — the
    // resolver tolerates a stale id, but leaving the dropdown
    // showing a deleted workflow name confuses the user.
    const sweep = ctx.db
      .prepare(`UPDATE notes SET workflow_id = NULL WHERE workflow_id = ?`)
      .run(id);
    const clearedTicketCount = sweep.changes ?? 0;
    // Sticky-delete by provenance (Codex P2a round 6, 2026-05-10).
    // See ./auto-code-workflows/sticky-delete.ts for the bookkeeping.
    recordStickyDeleteForRow(ctx.settings, target.folderId, id);
    const deleted = repo.delete(id);
    if (!deleted) return c.json({ error: 'workflow_not_found' }, 404);
    return c.json({ ok: true, clearedFolderId, clearedTicketCount });
  });

  /** Clone a workflow within the same folder. The new row gets
   *  `name = "<original> (copy)"` and `isDefault = false` (only one
   *  default per folder; cloning never silently demotes the original). */
  app.post('/api/auto-code/workflows/:id/clone', (c) => {
    const id = c.req.param('id');
    const repo = new WorkflowsRepository(ctx.db);
    const source = repo.getById(id);
    if (!source) return c.json({ error: 'workflow_not_found' }, 404);
    try {
      const created = repo.create({
        folderId: source.folderId,
        name: `${source.name} (copy)`,
        definition: source.definition,
        isDefault: false,
      });
      return c.json(created, 201);
    } catch (err) {
      return c.json(
        {
          error: 'invalid_workflow_definition',
          message: (err as Error).message,
        },
        422,
      );
    }
  });
}

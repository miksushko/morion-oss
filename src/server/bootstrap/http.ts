import { Hono } from 'hono';
import type { ToolContext } from '../tools/types.js';
import { registerErrorHandler } from '../middleware/error.js';
import { registerCors } from '../middleware/cors.js';
import { registerAuthGate } from '../middleware/auth.js';
import { registerSystemRoutes } from '../routes/system.js';
import { registerUpdateRoutes } from '../routes/updates.js';
import { registerInstallRoutes } from '../routes/install.js';
import { registerNoteRoutes } from '../routes/notes.js';
import { registerFolderRoutes } from '../routes/folders.js';
import { registerKanbanRoutes } from '../routes/kanban.js';
import { registerPermissionsRoutes } from '../routes/permissions.js';
import { registerTagRoutes } from '../routes/tags.js';
import { registerSearchRoutes } from '../routes/search.js';
import { registerSettingsRoutes } from '../routes/settings.js';
import { registerAttachmentRoutes } from '../routes/attachments.js';
import { registerCommentsRoutes } from '../routes/comments.js';
import { registerConciergeRoutes } from '../routes/concierge.js';
import { registerImportRoutes } from '../routes/import.js';
import { registerSkillsRoutes } from '../routes/skills.js';
import { registerStaticUi } from '../routes/static-ui.js';

/**
 * Builds the hono HTTP app that powers the React UI.
 *
 * Transport: bound to 127.0.0.1 only (loopback). Every `/api/*`
 * request (except `/api/health`) must carry an `X-Morion-Token`
 * header matching `MORION_API_TOKEN` from the Tauri shell's env —
 * the auth middleware below enforces this with a constant-time
 * compare. Dev (`npm run dev`) and vitest skip the check because
 * the env var is empty. See Direction I (v0.97.0) in
 * `docs/PLAN.md` for the threat model.
 *
 * Structure: this file used to be 1200 lines with every route
 * inlined. R1 (2026-04-17) split it into `middleware/` and `routes/`
 * by bounded context — each file is ≤300 lines, one concern, import
 * only what it needs. `buildHttpApp` is now just composition: wire
 * the middleware, mount every `register*Routes(app, ctx)`, hand
 * back the Hono instance.
 *
 * Order of registration matters:
 *   1. Error handler first so Zod 400s catch anything that throws.
 *   2. CORS second so preflight OPTIONS succeed without auth.
 *   3. Auth gate third — rejects unauthorised `/api/*` early.
 *   4. Routes in order of specificity: literal-first paths
 *      (kanban's `/:id/kanban`, notes's `/trash`) must be declared
 *      before their `/:id` parents. Each route module handles its
 *      own internal ordering — kanban routes before notes catch-all,
 *      folders/duplicate before folders/:id PATCH, etc.
 *   5. Static UI last so it doesn't shadow any `/api/*` path.
 */
export function buildHttpApp(ctxBase: Omit<ToolContext, 'actor'>): Hono {
  const app = new Hono();
  const actor = 'user';
  const ctx: ToolContext = { ...ctxBase, actor };

  registerErrorHandler(app);
  registerCors(app);
  registerAuthGate(app);

  registerSystemRoutes(app, ctxBase);
  registerUpdateRoutes(app);
  registerInstallRoutes(app);
  registerNoteRoutes(app, ctx);
  registerKanbanRoutes(app, ctx);
  registerFolderRoutes(app, ctx);
  registerPermissionsRoutes(app, ctx);
  registerTagRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerAttachmentRoutes(app, ctx);
  registerCommentsRoutes(app, ctx);
  registerConciergeRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerImportRoutes(app, ctx);
  registerSkillsRoutes(app);

  registerStaticUi(app);

  return app;
}

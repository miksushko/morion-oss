import type { Hono } from 'hono';
import { z } from 'zod';
import type { ToolContext } from '../tools/types.js';
import { ALL_TOOLS } from '../tools/index.js';
import { TOOL_CATEGORIES, type ToolCategory } from '../../core/settings/repository.js';
import { CURRENT_TERMS_VERSION } from '../../core/terms.js';

/**
 * MCP settings panel + the recent audit rows used by "Connected
 * clients".
 *
 * The UI calls `GET /api/settings` on mount to render the toggle
 * states. The returned shape mirrors `McpSettings` from the repo +
 * a static `toolsByCategory` breakdown so the UI can render
 * "Read (7)" / "Create (6)" / etc. without hard-coding the list.
 * Tools are derived from `ALL_TOOLS` at request time so adding a
 * new tool with a category lights up in the UI without an extra
 * edit (R5 fix 2026-04-16).
 */
export function registerSettingsRoutes(app: Hono, ctx: ToolContext): void {
  app.get('/api/settings', (c) => {
    const mcp = ctx.settings.getMcpSettings();
    const toolsByCategory: Record<ToolCategory, Array<{ name: string; description: string }>> = {
      read: [],
      create: [],
      update: [],
      delete: [],
    };
    for (const tool of ALL_TOOLS) {
      toolsByCategory[tool.category].push({
        name: tool.name,
        description: tool.description,
      });
    }
    // Direction Q — comments-related toggles. Exposed as siblings of
    // the main `mcp` bag so the Settings UI can render them as
    // independent rows without fighting the per-category layout.
    // First-run consent. `current` is the ToS version the build was
    // shipped against (single source of truth in core/terms.ts);
    // `accepted` is what the user clicked on, or null if they never
    // did. The frontend gates main UI rendering on current===accepted.
    const storedTerms = ctx.settings.getTerms();
    return c.json({
      mcp,
      toolsByCategory,
      comments: {
        mcpCommentsEditable: ctx.settings.getMcpCommentsEditable(),
        requireLlmStatusComment: ctx.settings.getRequireLlmStatusComment(),
      },
      terms: {
        current: CURRENT_TERMS_VERSION,
        acceptedAt: storedTerms.acceptedAt,
        acceptedVersion: storedTerms.version,
      },
    });
  });

  // First-run consent accept. Body carries the version string the
  // frontend rendered so the persisted record matches what the user
  // actually saw. Validated against the current build's constant —
  // a mismatch means the frontend is stale or a bad actor is poking
  // the endpoint; either way we refuse.
  const acceptTermsSchema = z.object({
    version: z.string().min(1).max(32),
  });

  app.post('/api/settings/accept-terms', async (c) => {
    const input = acceptTermsSchema.parse(await c.req.json());
    if (input.version !== CURRENT_TERMS_VERSION) {
      return c.json(
        { error: 'terms_version_mismatch', expected: CURRENT_TERMS_VERSION },
        400,
      );
    }
    ctx.settings.acceptTerms(input.version);
    const stored = ctx.settings.getTerms();
    return c.json({
      current: CURRENT_TERMS_VERSION,
      acceptedAt: stored.acceptedAt,
      acceptedVersion: stored.version,
    });
  });

  // PATCH accepts a partial update of the MCP gates. Either
  // `enabled` or any subset of `categories` can be provided. The
  // repository writes each key independently so a half-applied
  // request still leaves the DB in a valid state — there's no
  // transaction wrapping because each setting is its own row and
  // the UI never updates more than 4 keys at once.
  const settingsPatchSchema = z.object({
    mcp: z
      .object({
        enabled: z.boolean().optional(),
        categories: z
          .object({
            read: z.boolean().optional(),
            create: z.boolean().optional(),
            update: z.boolean().optional(),
            delete: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    comments: z
      .object({
        mcpCommentsEditable: z.boolean().optional(),
        requireLlmStatusComment: z.boolean().optional(),
      })
      .optional(),
  });

  app.patch('/api/settings', async (c) => {
    const body = await c.req.json();
    const input = settingsPatchSchema.parse(body);
    if (input.mcp?.enabled !== undefined) {
      ctx.settings.setMcpEnabled(input.mcp.enabled);
    }
    if (input.mcp?.categories) {
      for (const cat of TOOL_CATEGORIES) {
        const next = input.mcp.categories[cat];
        if (next !== undefined) ctx.settings.setMcpCategory(cat, next);
      }
    }
    if (input.comments?.mcpCommentsEditable !== undefined) {
      ctx.settings.setMcpCommentsEditable(input.comments.mcpCommentsEditable);
    }
    if (input.comments?.requireLlmStatusComment !== undefined) {
      ctx.settings.setRequireLlmStatusComment(input.comments.requireLlmStatusComment);
    }
    return c.json({
      mcp: ctx.settings.getMcpSettings(),
      comments: {
        mcpCommentsEditable: ctx.settings.getMcpCommentsEditable(),
        requireLlmStatusComment: ctx.settings.getRequireLlmStatusComment(),
      },
    });
  });

  // Recent audit rows for the Settings panel "Connected clients"
  // section. Always emits MCP-only entries (`actor LIKE 'mcp:%'`
  // enforced server-side) because that's the only thing the panel
  // cares about — surfacing user-actor edits would just be noise.
  const auditQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });

  app.get('/api/audit/mcp', (c) => {
    const parsed = auditQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    // The repo doesn't expose a LIKE filter, so over-fetch and trim.
    // With a 200-row cap this is cheap; a sustained MCP user with >
    // 200 audit rows can paginate, which is out of scope for this
    // slice.
    const all = ctx.audit.recent(parsed.limit * 4);
    return c.json(all.filter((r) => r.actor.startsWith('mcp:')).slice(0, parsed.limit));
  });
}

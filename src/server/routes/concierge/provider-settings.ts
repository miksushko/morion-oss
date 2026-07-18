/**
 * Workspace-level Mo provider / pipeline / personality / budget
 * settings routes.
 *
 * - GET/PUT /api/concierge/provider          — backend + api key + model.
 * - GET/PUT /api/concierge/pipeline-models   — per-backend pipeline
 *     model overrides (tier1/tier2/subagent/synthesis/topic-hygiene/
 *     merge-resolver/workflow-builder — 13 fields, single Zod patch
 *     shape).
 * - GET/PUT /api/concierge/mo                — Mo personality + schedule.
 * - GET     /api/concierge/budget            — Mo chat-side monthly cap status.
 *
 * For ollama the "api key" field is reused as the base URL (no
 * secret to stash) — same patch shape, different semantics. UI
 * knows which one to send based on the active backend.
 *
 * Extracted from `src/server/routes/concierge.ts` (slice 7/N of the
 * route-file split, ticket 01KRJYX50FMDQ94V3464T56K5F). Pure code-
 * motion — behaviour unchanged.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import {
  MO_INDEXING_DEFAULTS_BACKEND,
  MO_INDEXING_TIER1_MODEL,
  MO_INDEXING_TIER1_FALLBACK,
  MO_INDEXING_TIER2_MODEL,
  MO_INDEXING_TIER2_FALLBACK,
  MO_INDEXING_TOPIC_HYGIENE_RECOMMENDED,
} from '../../../core/concierge/mo-indexing-tick.js';
import {
  GATHER_SUBAGENT_RECOMMENDED,
  GATHER_SYNTHESIS_DEFAULT_RECOMMENDED,
  GATHER_SYNTHESIS_THOROUGH_RECOMMENDED,
  MERGE_RESOLVER_PRIMARY_RECOMMENDED,
  MERGE_RESOLVER_FALLBACK_RECOMMENDED,
  WORKFLOW_BUILDER_PRIMARY_RECOMMENDED,
  WORKFLOW_BUILDER_FALLBACK_RECOMMENDED,
  gatherSubagentModelKey,
  gatherSynthesisModelKey,
  gatherSynthesisThoroughModelKey,
  mergeResolverFallbackKey,
  mergeResolverModelKey,
  readBackend,
  readConfiguredProvider,
  tier1FallbackKey,
  tier1ModelKey,
  tier2FallbackKey,
  tier2ModelKey,
  topicHygieneFallbackKey,
  topicHygieneModelKey,
  workflowBuilderFallbackKey,
  workflowBuilderModelKey,
} from '../../features/concierge-deps/index.js';
import {
  MO_BUDGET_SETTING_KEY,
  MONTHLY_CAP_USD,
} from '../../../core/concierge/budget.js';
import type { ToolContext } from '../../tools/types.js';
import { asHost, requireConciergeDeps } from './shared.js';

const providerPatchSchema = z.object({
  backend: z
    .enum(['groq', 'openrouter', 'ollama', 'openai', 'anthropic'])
    .optional(),
  apiKey: z.string().optional(),
  model: z.string().max(200).optional(),
});

// Trim to a sensible model-id length so a fat-fingered paste doesn't
// accumulate megabytes in settings rows. 200 chars is enough for the
// longest known OpenRouter slug + a build hash suffix.
const PIPELINE_MODEL_MAX = 200;
const pipelineModelField = z.string().max(PIPELINE_MODEL_MAX).optional();
const pipelineModelsPatchSchema = z.object({
  tier1: pipelineModelField,
  tier1Fallback: pipelineModelField,
  tier2: pipelineModelField,
  tier2Fallback: pipelineModelField,
  subagent: pipelineModelField,
  synthesis: pipelineModelField,
  synthesisThorough: pipelineModelField,
  topicHygiene: pipelineModelField,
  topicHygieneFallback: pipelineModelField,
  mergeResolver: pipelineModelField,
  mergeResolverFallback: pipelineModelField,
  workflowBuilder: pipelineModelField,
  workflowBuilderFallback: pipelineModelField,
});

const moPersonalitySchema = z.object({
  grumpyMode: z.boolean().optional(),
  // Direction X — global kill-switch for Checking Corners. When
  // false, digests never run and ticks don't prepend briefs, even
  // if a folder has checkingCornersEnabled=1. Default true so the
  // feature is opt-out at the global level (per-folder opt-in is
  // the real gate).
  checkingCornersMaster: z.boolean().optional(),
  // Workspace-level schedule (2026-04-25). Used to live per-folder
  // in `concierge_folder_settings` but every dogfood case had the
  // user setting the same cadence everywhere — duplicate config
  // for no benefit. Per-folder columns stay in the DB for
  // backward-compat but the scheduler now reads this workspace
  // setting first; per-folder fields are no longer surfaced in UI.
  scheduleMode: z.enum(['manual', 'timer']).optional(),
  scheduleMinutes: z
    .union([z.literal(1), z.literal(5), z.literal(15)])
    .optional(),
});

export function registerProviderSettingsRoutes(
  app: Hono,
  ctx: ToolContext,
): void {
  // ------- Provider (global) -----------------------------------------
  // API key + model live in the settings KV (shared across folders).
  // Exposed as a dedicated endpoint so the Settings dialog can read +
  // write them without constructing a full structured /api/settings
  // PATCH payload. Key is never returned verbatim on GET — UI only
  // needs to know whether it's configured.
  app.get('/api/concierge/provider', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    const configured = readConfiguredProvider(asHost(ctx));
    return c.json({
      // For groq/openrouter: report presence + last-4 digits, never the
      // full key (Tauri webview has no trusted sandbox for secrets).
      // For ollama: there's no secret — return the full base URL the
      // UI can show plainly + edit. `hasApiKey` for ollama means the
      // user explicitly set a non-default base URL.
      backend: configured.backend,
      hasApiKey: configured.key.length > 0,
      apiKeyHint:
        configured.backend === 'ollama'
          ? configured.key || ''
          : configured.storedKey
            ? `…${configured.storedKey.slice(-4)}`
            : configured.envConfigured
              ? 'configured via env'
              : '',
      model: configured.model,
    });
  });

  app.put('/api/concierge/provider', async (c) => {
    const patch = providerPatchSchema.parse(await c.req.json());
    if (patch.backend !== undefined) {
      ctx.settings.set('concierge.backend', patch.backend);
    }
    const backend = patch.backend ?? readBackend(asHost(ctx));
    // Per-backend key/model setting names mirror BACKEND_CONFIGS in
    // concierge-deps.ts. For ollama the "key" is the base URL (no
    // secret); same code path, different semantics — that file is the
    // single source of truth. Ternary-on-backend was the bug class
    // adding a third backend would silently miss.
    const keySettingByBackend: Record<typeof backend, string> = {
      groq: 'concierge.groq_api_key',
      openrouter: 'concierge.openrouter_api_key',
      ollama: 'concierge.ollama_base_url',
      openai: 'concierge.openai_api_key',
      anthropic: 'concierge.anthropic_api_key',
    };
    const modelSettingByBackend: Record<typeof backend, string> = {
      groq: 'concierge.groq_model',
      openrouter: 'concierge.openrouter_model',
      ollama: 'concierge.ollama_model',
      openai: 'concierge.openai_model',
      anthropic: 'concierge.anthropic_model',
    };
    if (patch.apiKey !== undefined) {
      ctx.settings.set(keySettingByBackend[backend], patch.apiKey);
    }
    if (patch.model !== undefined) {
      ctx.settings.set(modelSettingByBackend[backend], patch.model);
    }
    const configured = readConfiguredProvider(asHost(ctx));
    return c.json({
      backend: configured.backend,
      hasApiKey: configured.key.length > 0,
      apiKeyHint:
        configured.backend === 'ollama'
          ? configured.key || ''
          : configured.storedKey
            ? `…${configured.storedKey.slice(-4)}`
            : configured.envConfigured
              ? 'configured via env'
              : '',
      model: configured.model,
    });
  });

  // ------- Per-pipeline model overrides (Phase 3.5 of epic ----------
  //         01KPGWTJCWVBQCCSQ8NGSB19KQ — Settings unification) ---------
  //
  // Each of the 11 per-pipeline knobs is optional. On OpenRouter an
  // empty field falls back to a curated built-in default; on every
  // other backend tier1 + tier2 are REQUIRED (no built-in defaults).
  // Resolution lives in concierge-deps.ts; UI surfaces them in Mo Agent
  // → API & Provider for ALL backends now (Mo runs on any configured
  // backend). DRY: single shape-builder used by both GET + PUT response
  // so the 11 setting keys + their recommended placeholders stay in one
  // place and don't drift apart.
  const buildPipelineModelsResponse = (
    backend: ReturnType<typeof readBackend>,
  ) => {
    const get = (key: string): string =>
      ctx.settings.get<string>(key, '') ?? '';
    // OpenRouter ships curated model recommendations; for other backends
    // we don't suggest ids (vendor-specific, and OpenRouter's namespaced
    // ids would 404 there) — the user fills tier1/tier2 in themselves.
    const isDefaultsBackend = backend === MO_INDEXING_DEFAULTS_BACKEND;
    const rec = (id: string): string => (isDefaultsBackend ? id : '');
    return {
      backend,
      pipelinesSupported: true,
      values: {
        tier1: get(tier1ModelKey(backend)),
        tier1Fallback: get(tier1FallbackKey(backend)),
        tier2: get(tier2ModelKey(backend)),
        tier2Fallback: get(tier2FallbackKey(backend)),
        subagent: get(gatherSubagentModelKey(backend)),
        synthesis: get(gatherSynthesisModelKey(backend)),
        synthesisThorough: get(gatherSynthesisThoroughModelKey(backend)),
        topicHygiene: get(topicHygieneModelKey(backend)),
        topicHygieneFallback: get(topicHygieneFallbackKey(backend)),
        mergeResolver: get(mergeResolverModelKey(backend)),
        mergeResolverFallback: get(mergeResolverFallbackKey(backend)),
        workflowBuilder: get(workflowBuilderModelKey(backend)),
        workflowBuilderFallback: get(workflowBuilderFallbackKey(backend)),
      },
      // Recommended placeholders: the model id we'd suggest if the
      // user wanted to override. Different from the FALLBACK the
      // resolver picks when the field is empty (which is shown via
      // the per-field hint copy in the UI). Informational typing-aid
      // only — never a shipped default per the "no hardcoded model
      // defaults" CLAUDE.md rule.
      recommended: {
        tier1: rec(MO_INDEXING_TIER1_MODEL),
        tier1Fallback: rec(MO_INDEXING_TIER1_FALLBACK),
        tier2: rec(MO_INDEXING_TIER2_MODEL),
        tier2Fallback: rec(MO_INDEXING_TIER2_FALLBACK),
        subagent: rec(GATHER_SUBAGENT_RECOMMENDED),
        synthesis: rec(GATHER_SYNTHESIS_DEFAULT_RECOMMENDED),
        synthesisThorough: rec(GATHER_SYNTHESIS_THOROUGH_RECOMMENDED),
        topicHygiene: rec(MO_INDEXING_TOPIC_HYGIENE_RECOMMENDED),
        topicHygieneFallback: '',
        mergeResolver: rec(MERGE_RESOLVER_PRIMARY_RECOMMENDED),
        mergeResolverFallback: rec(MERGE_RESOLVER_FALLBACK_RECOMMENDED),
        workflowBuilder: rec(WORKFLOW_BUILDER_PRIMARY_RECOMMENDED),
        workflowBuilderFallback: rec(WORKFLOW_BUILDER_FALLBACK_RECOMMENDED),
      },
    };
  };

  app.get('/api/concierge/pipeline-models', (c) => {
    return c.json(buildPipelineModelsResponse(readBackend(asHost(ctx))));
  });

  app.put('/api/concierge/pipeline-models', async (c) => {
    const patch = pipelineModelsPatchSchema.parse(await c.req.json());
    const backend = readBackend(asHost(ctx));
    // Pair each input field with its per-backend setting key. Empty
    // string clears the override (resolver falls back to the
    // hardcoded constant default). undefined means "don't touch this
    // field on this PATCH".
    const writes: Array<[string | undefined, string]> = [
      [patch.tier1, tier1ModelKey(backend)],
      [patch.tier1Fallback, tier1FallbackKey(backend)],
      [patch.tier2, tier2ModelKey(backend)],
      [patch.tier2Fallback, tier2FallbackKey(backend)],
      [patch.subagent, gatherSubagentModelKey(backend)],
      [patch.synthesis, gatherSynthesisModelKey(backend)],
      [patch.synthesisThorough, gatherSynthesisThoroughModelKey(backend)],
      [patch.topicHygiene, topicHygieneModelKey(backend)],
      [patch.topicHygieneFallback, topicHygieneFallbackKey(backend)],
      [patch.mergeResolver, mergeResolverModelKey(backend)],
      [patch.mergeResolverFallback, mergeResolverFallbackKey(backend)],
      [patch.workflowBuilder, workflowBuilderModelKey(backend)],
      [patch.workflowBuilderFallback, workflowBuilderFallbackKey(backend)],
    ];
    for (const [value, key] of writes) {
      if (value !== undefined) {
        ctx.settings.set(key, value.trim());
      }
    }
    return c.json(buildPipelineModelsResponse(backend));
  });

  // ------- Mo personality (global settings for Ask Mo) ---------------
  // Lives on the Ask Mo panel's settings gear. Extending to more fields
  // (name overrides, model choice, etc.) comes later.
  const readMoPersonality = () => ({
    grumpyMode: ctx.settings.get<boolean>('concierge.grumpy_chat', true),
    checkingCornersMaster: ctx.settings.get<boolean>(
      'concierge.checking_corners_master',
      true,
    ),
    scheduleMode: ctx.settings.get<'manual' | 'timer'>(
      'concierge.schedule_mode',
      'manual',
    ),
    scheduleMinutes: ctx.settings.get<1 | 5 | 15>(
      'concierge.schedule_minutes',
      5,
    ),
  });

  app.get('/api/concierge/mo', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    return c.json(readMoPersonality());
  });

  app.put('/api/concierge/mo', async (c) => {
    const patch = moPersonalitySchema.parse(await c.req.json());
    if (patch.grumpyMode !== undefined) {
      ctx.settings.set('concierge.grumpy_chat', patch.grumpyMode);
    }
    if (patch.checkingCornersMaster !== undefined) {
      ctx.settings.set(
        'concierge.checking_corners_master',
        patch.checkingCornersMaster,
      );
    }
    if (patch.scheduleMode !== undefined) {
      ctx.settings.set('concierge.schedule_mode', patch.scheduleMode);
    }
    if (patch.scheduleMinutes !== undefined) {
      ctx.settings.set('concierge.schedule_minutes', patch.scheduleMinutes);
    }
    return c.json(readMoPersonality());
  });

  // ------- Mo chat-tier budget (separate from auto-code budget) -----
  app.get('/api/concierge/budget', (c) => {
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    return c.json(bag.bag.budget.status());
  });

  // PUT Mo monthly cap. Ticket 01KRNCDK0Y16R8QS8YP2AGSPTF — Limits tab.
  // Mirrors the auto-code PUT shape: number body, clamped to [0,
  // 10×default] (= $100 max). $0 acts as a kill-switch — `withinBudget`
  // immediately flips false, every paid Mo path returns
  // `mo_budget_exceeded`. The Limits-tab input enforces the same range
  // client-side but the server is the authority.
  app.put('/api/concierge/budget', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const raw = body?.monthlyCapUsd;
    const cap =
      typeof raw === 'number' && Number.isFinite(raw)
        ? raw
        : typeof raw === 'string'
          ? Number.parseFloat(raw)
          : NaN;
    if (!Number.isFinite(cap) || cap < 0 || cap > 10 * MONTHLY_CAP_USD) {
      return c.json(
        {
          error: 'cap_out_of_range',
          message: `monthlyCapUsd must be between 0 and ${10 * MONTHLY_CAP_USD}`,
        },
        400,
      );
    }
    ctx.settings.set(MO_BUDGET_SETTING_KEY, cap);
    const bag = requireConciergeDeps(ctx);
    if (!bag.ok) return c.json({ error: 'concierge_not_wired' }, 501);
    // Tracker re-reads via the callback wired in runtime — status()
    // already reflects the new cap without a rebuild.
    return c.json(bag.bag.budget.status());
  });
}

import { z } from 'zod';
import { defineTool } from './types.js';
import { canPerform, ACCESS_DENIED } from '../../core/permissions/check.js';
import {
  detectAgentAvailability,
  runPreflight,
} from '../../core/auto-code/preflight.js';
import {
  BACKEND_CONFIGS,
  readEnvFirst,
} from '../features/concierge-deps/backend-configs.js';
import { readBackend } from '../features/concierge-deps/provider-routing.js';
import type { ConciergeBackend } from '../features/concierge-deps/types.js';
import { ConciergeFolderSettingsRepository } from '../../core/concierge/folder-settings-repository.js';
import { readFolderWorkflowTemplate } from '../features/auto-code-template-settings.js';

/**
 * Report what is available on THIS machine for building Auto-code
 * workflows: which CLI agent binaries are installed, which LLM
 * backends have keys configured, and (when `folderId` is given) the
 * folder's auto-code state + preflight blockers.
 *
 * The intended first call of the workflow-authoring recipe: an
 * external agent checks the environment BEFORE drafting a
 * WorkflowDefinition so it only proposes agents/providers the user
 * can actually run.
 *
 * Key presence is reported as booleans only — never the values.
 * There is deliberately NO model catalog: model ids are free-text
 * (vendors ship new ones monthly), so agents should reuse what the
 * user configured or ask.
 */
export const workflowsEnvironmentTool = defineTool({
  name: 'workflows_environment',
  description:
    'Report what is available for Auto-code workflows on this machine: installed CLI agents (claude/codex/pi/opencode), which LLM backends have API keys configured (booleans only, never values; ollama needs no key — it falls back to http://127.0.0.1:11434), and — when folderId is passed — the folder auto-code state (Mo enabled, auto-code enabled, linked repo, concurrency cap, default workflow id) plus preflight blockers. Call this FIRST before drafting a workflow so you only propose agents the user can run. There is no model catalog by design: model ids are free-text — reuse what the user configured or ask them. read-only.',
  category: 'read',
  inputShape: {
    folderId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional folder to include auto-code state + preflight for. Omit for the machine-level report only.',
      ),
  },
  async handler(input, ctx) {
    const agents = detectAgentAvailability();

    const backends = {} as Record<ConciergeBackend, { keyConfigured: boolean }>;
    for (const [name, cfg] of Object.entries(BACKEND_CONFIGS) as Array<
      [ConciergeBackend, (typeof BACKEND_CONFIGS)[ConciergeBackend]]
    >) {
      const stored = ctx.settings.get<string>(cfg.keySetting, '').trim();
      const env = readEnvFirst(cfg.envKeys);
      backends[name] = { keyConfigured: stored.length > 0 || env.length > 0 };
    }

    const selected = readBackend({ settings: ctx.settings });
    const chatModelConfigured =
      ctx.settings
        .get<string>(BACKEND_CONFIGS[selected].modelSetting, '')
        .trim().length > 0;
    // Ollama is keyless local inference — its "key" is a base URL with
    // a localhost default, so a missing key does not block readiness.
    const selectedReady =
      chatModelConfigured &&
      (selected === 'ollama' || backends[selected].keyConfigured);

    const base = {
      agents,
      moBackends: { selected, selectedReady, chatModelConfigured, backends },
    };
    if (!input.folderId) return base;

    if (!canPerform('read', ctx, { kind: 'folder', folderId: input.folderId })) {
      return ACCESS_DENIED;
    }
    const folder = ctx.folders.getById(input.folderId);
    if (!folder) {
      return {
        error: 'folder_not_found',
        message: `No folder with id ${input.folderId}.`,
      };
    }
    const folderSettings = new ConciergeFolderSettingsRepository(
      ctx.db,
    ).getOrDefault(input.folderId);
    const pre = runPreflight();

    return {
      ...base,
      folder: {
        id: folder.id,
        name: folder.name,
        moEnabled: folderSettings.enabled,
        autoCodeEnabled: folderSettings.autoCodeEnabled,
        linkedRepoPath: folderSettings.linkedRepoPath,
        autoCodeConcurrency: folderSettings.autoCodeConcurrency,
        defaultWorkflowId: readFolderWorkflowTemplate(
          ctx.settings,
          input.folderId,
        ),
        preflight: {
          blocking: pre.blocking,
          mcp: {
            claude: {
              installed: pre.mcp.claude.installed,
              error: pre.mcp.claude.error,
            },
            codex: {
              installed: pre.mcp.codex.installed,
              error: pre.mcp.codex.error,
            },
          },
        },
      },
    };
  },
});

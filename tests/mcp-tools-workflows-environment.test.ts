import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workflowsEnvironmentTool } from '../src/server/tools/plugins/auto-code.js';
import { type Ctx, setup } from './mcp-tools/helpers.js';
import { BACKEND_CONFIGS } from '../src/server/features/concierge-deps/backend-configs.js';
import { ConciergeFolderSettingsRepository } from '../src/core/concierge/folder-settings-repository.js';
import { DEFAULT_TEMPLATE_ID } from '../src/core/auto-code/workflows/templates.js';

/**
 * `workflows_environment` MCP tool — Mo Workflows epic.
 *
 * The environment report an external agent calls FIRST before
 * drafting a WorkflowDefinition: installed CLI agents, configured
 * backends (booleans only), folder auto-code state + preflight.
 */

const AGENT_NAMES = ['claude', 'codex', 'pi', 'opencode'] as const;
const BACKEND_NAMES = Object.keys(BACKEND_CONFIGS);
const ALL_ENV_KEYS = Object.values(BACKEND_CONFIGS).flatMap((c) => [
  ...c.envKeys,
]);

interface EnvironmentResult {
  agents: Record<
    string,
    { ready: boolean; path: string | null; error: string | null }
  >;
  moBackends: {
    selected: string;
    selectedReady: boolean;
    chatModelConfigured: boolean;
    backends: Record<string, { keyConfigured: boolean }>;
  };
  folder?: {
    id: string;
    name: string;
    moEnabled: boolean;
    autoCodeEnabled: boolean;
    linkedRepoPath: string | null;
    autoCodeConcurrency: number | null;
    defaultWorkflowId: string;
    preflight: {
      blocking: string[];
      mcp: {
        claude: { installed: boolean; error: string | null };
        codex: { installed: boolean; error: string | null };
      };
    };
  };
  error?: string;
}

describe('MCP tools — workflows_environment', () => {
  let ctx: Ctx;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    ctx = setup();
    // Backend key presence reads settings THEN env — clear every
    // env fallback so assertions are deterministic on dev machines
    // that export real provider keys.
    for (const k of ALL_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ALL_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('machine-level report covers all agents + backends and omits folder', async () => {
    const res = (await workflowsEnvironmentTool.handler(
      {},
      ctx.tc,
    )) as EnvironmentResult;

    for (const agent of AGENT_NAMES) {
      expect(res.agents[agent]).toBeTruthy();
      expect(typeof res.agents[agent].ready).toBe('boolean');
    }
    for (const backend of BACKEND_NAMES) {
      expect(typeof res.moBackends.backends[backend].keyConfigured).toBe(
        'boolean',
      );
      expect(res.moBackends.backends[backend].keyConfigured).toBe(false);
    }
    expect(BACKEND_NAMES).toContain(res.moBackends.selected);
    expect(res.folder).toBeUndefined();
  });

  it('keyConfigured flips when a backend key setting is stored (value never leaks)', async () => {
    ctx.tc.settings.set('concierge.openrouter_api_key', 'sk-or-secret-123');

    const res = (await workflowsEnvironmentTool.handler(
      {},
      ctx.tc,
    )) as EnvironmentResult;

    expect(res.moBackends.backends.openrouter.keyConfigured).toBe(true);
    expect(res.moBackends.backends.groq.keyConfigured).toBe(false);
    expect(JSON.stringify(res)).not.toContain('sk-or-secret-123');
  });

  it('selectedReady requires key + chat model; ollama is keyless', async () => {
    ctx.tc.settings.set('concierge.backend', 'openrouter');
    ctx.tc.settings.set('concierge.openrouter_api_key', 'sk-or-x');
    let res = (await workflowsEnvironmentTool.handler(
      {},
      ctx.tc,
    )) as EnvironmentResult;
    expect(res.moBackends.selected).toBe('openrouter');
    // Key present but no chat model yet.
    expect(res.moBackends.selectedReady).toBe(false);

    ctx.tc.settings.set('concierge.openrouter_model', 'deepseek/deepseek-v3');
    res = (await workflowsEnvironmentTool.handler(
      {},
      ctx.tc,
    )) as EnvironmentResult;
    expect(res.moBackends.selectedReady).toBe(true);

    // Ollama needs no key — model alone is enough (localhost default).
    ctx.tc.settings.set('concierge.backend', 'ollama');
    ctx.tc.settings.set('concierge.ollama_model', 'qwen3:14b');
    res = (await workflowsEnvironmentTool.handler(
      {},
      ctx.tc,
    )) as EnvironmentResult;
    expect(res.moBackends.selected).toBe('ollama');
    expect(res.moBackends.backends.ollama.keyConfigured).toBe(false);
    expect(res.moBackends.selectedReady).toBe(true);
  });

  it('folder variant reports auto-code state + default workflow + preflight', async () => {
    const folder = ctx.tc.folders.create('F');
    new ConciergeFolderSettingsRepository(ctx.handle.db).update(folder.id, {
      enabled: true,
      linkedRepoPath: '/tmp/some-repo',
      autoCodeEnabled: true,
      autoCodeConcurrency: 2,
    });

    const res = (await workflowsEnvironmentTool.handler(
      { folderId: folder.id },
      ctx.tc,
    )) as EnvironmentResult;

    expect(res.folder).toBeTruthy();
    expect(res.folder?.id).toBe(folder.id);
    expect(res.folder?.moEnabled).toBe(true);
    expect(res.folder?.autoCodeEnabled).toBe(true);
    expect(res.folder?.linkedRepoPath).toBe('/tmp/some-repo');
    expect(res.folder?.autoCodeConcurrency).toBe(2);
    expect(res.folder?.defaultWorkflowId).toBe(DEFAULT_TEMPLATE_ID);
    expect(Array.isArray(res.folder?.preflight.blocking)).toBe(true);
    expect(typeof res.folder?.preflight.mcp.claude.installed).toBe('boolean');
    expect(typeof res.folder?.preflight.mcp.codex.installed).toBe('boolean');
  });

  it('unknown folder → mcp_access_denied (visibility gate fires first)', async () => {
    const res = (await workflowsEnvironmentTool.handler(
      { folderId: 'no-such-folder' },
      ctx.tc,
    )) as EnvironmentResult;
    expect(res.error).toBe('mcp_access_denied');
  });

  it('user actor bypasses the folder gate but still gets folder_not_found on a missing id', async () => {
    const userCtx = setup('user');
    const res = (await workflowsEnvironmentTool.handler(
      { folderId: 'no-such-folder' },
      userCtx.tc,
    )) as EnvironmentResult;
    expect(res.error).toBe('folder_not_found');
  });
});

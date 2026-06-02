import { describe, it, expect, beforeEach } from 'vitest';

import { openDb, type DbHandle } from '../src/core/db/client.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import { buildAgentApiKeyEnv } from '../src/server/features/concierge-deps/index.js';
import type { ConciergeDepsHost } from '../src/server/features/concierge-deps/index.js';

/**
 * Phase 4.6 (2026-05-11) — `buildAgentApiKeyEnv` exposes Mo's stored
 * provider keys as standard env vars (OPENROUTER_API_KEY,
 * ANTHROPIC_API_KEY, etc.) so spawned Pi / Opencode child processes
 * route through the same backend Mo uses without needing a separate
 * `pi login` / `opencode login` step.
 */

function makeHost(settings: SettingsRepository, db: DbHandle): ConciergeDepsHost {
  return {
    db: db.db,
    notes: null as never,
    folders: null as never,
    comments: null as never,
    settings,
    concierge: null as never,
    embeddings: null,
  };
}

describe('buildAgentApiKeyEnv', () => {
  let handle: DbHandle;
  let settings: SettingsRepository;
  beforeEach(() => {
    handle = openDb({ path: ':memory:' });
    settings = new SettingsRepository(handle.db);
    // Wipe known env vars so tests stay deterministic regardless of
    // the developer's shell setup.
    for (const k of [
      'MORION_OPENROUTER_API_KEY',
      'OPEN_ROUTER_KEY',
      'OPENROUTER_API_KEY',
      'MORION_ANTHROPIC_API_KEY',
      'ANTHROPIC_API_KEY',
      'MORION_OPENAI_API_KEY',
      'OPENAI_API_KEY',
      'MORION_GROQ_API_KEY',
      'GROQ_API_KEY',
      'GROQ_KEY',
      'MORION_OLLAMA_BASE_URL',
      'OLLAMA_BASE_URL',
    ]) {
      delete process.env[k];
    }
  });

  it('returns empty when nothing is configured', () => {
    const env = buildAgentApiKeyEnv(makeHost(settings, handle));
    expect(env).toEqual({});
  });

  it('emits OPENROUTER_API_KEY when Mo has OpenRouter configured', () => {
    settings.set('concierge.openrouter_api_key', 'sk-or-test-123');
    const env = buildAgentApiKeyEnv(makeHost(settings, handle));
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-test-123');
  });

  it('emits multiple keys when multiple backends are configured', () => {
    settings.set('concierge.openrouter_api_key', 'sk-or-1');
    settings.set('concierge.anthropic_api_key', 'sk-ant-1');
    settings.set('concierge.openai_api_key', 'sk-openai-1');
    settings.set('concierge.groq_api_key', 'gsk-1');
    settings.set('concierge.ollama_base_url', 'http://127.0.0.1:11434');
    const env = buildAgentApiKeyEnv(makeHost(settings, handle));
    expect(env).toEqual({
      OPENROUTER_API_KEY: 'sk-or-1',
      ANTHROPIC_API_KEY: 'sk-ant-1',
      OPENAI_API_KEY: 'sk-openai-1',
      GROQ_API_KEY: 'gsk-1',
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    });
  });

  it('falls back to env var when stored setting is empty', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-from-shell';
    const env = buildAgentApiKeyEnv(makeHost(settings, handle));
    // The setting is empty, so the env reader checks the standard
    // names. `OPENROUTER_API_KEY` isn't in our `envKeys` list
    // (MORION_* / OPEN_ROUTER_KEY) — but the standard name might
    // be hit by another tool. The function MUST not silently use
    // the standard env name as input — it'd create an echo loop.
    // Verified: only MORION_OPENROUTER_API_KEY / OPEN_ROUTER_KEY
    // listed as the read path.
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it('reads from MORION_OPENROUTER_API_KEY env when stored is empty', () => {
    process.env.MORION_OPENROUTER_API_KEY = 'sk-or-morion-env';
    const env = buildAgentApiKeyEnv(makeHost(settings, handle));
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-morion-env');
  });

  it('stored key wins over env var', () => {
    settings.set('concierge.openrouter_api_key', 'sk-stored');
    process.env.MORION_OPENROUTER_API_KEY = 'sk-env';
    const env = buildAgentApiKeyEnv(makeHost(settings, handle));
    expect(env.OPENROUTER_API_KEY).toBe('sk-stored');
  });

  it('omits backends with no key configured (clean object, not undefined-valued)', () => {
    settings.set('concierge.openrouter_api_key', 'only-or');
    const env = buildAgentApiKeyEnv(makeHost(settings, handle));
    expect(Object.keys(env).sort()).toEqual(['OPENROUTER_API_KEY']);
  });
});

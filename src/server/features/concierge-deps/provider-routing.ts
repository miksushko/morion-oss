/**
 * Provider routing helpers — resolve backend selection, API key, model
 * picks from settings + env, and return the right LLMProvider instance.
 *
 * Single source of truth for "what provider does Mo use right now" —
 * called from chat path, scheduler, indexing tick, gather pipeline,
 * and per-spawn CLI sub-agent env injection.
 */
import {
  NoopLLMProvider,
  type LLMProvider,
} from '../../../core/concierge/index.js';
import {
  BACKEND_CONFIGS,
  BACKEND_FACTORIES,
  DEFAULT_BACKEND,
  readEnvFirst,
} from './backend-configs.js';
import type {
  ConciergeBackend,
  ConciergeDepsHost,
  ConfiguredProvider,
} from './types.js';

/**
 * Build an env-var map for spawning CLI sub-agents (Pi / Opencode)
 * that share Morion's configured Mo provider keys instead of needing
 * their own separate `pi login` / `opencode login` step.
 *
 * Pi / Opencode read API keys from environment first, then their own
 * config files. Injecting Mo's stored keys at spawn time means a user
 * who configured "Settings → Mo → OpenRouter API key" gets Pi
 * routing to OpenRouter for free — no duplicate setup.
 *
 * Only emits keys that are actually set (stored OR env-resolved); a
 * missing Mo backend means an empty / omitted env var, leaving the
 * CLI's own config-file resolution path intact for that provider.
 *
 * Ollama is special — the "key" is a base URL; emitted as
 * `OLLAMA_BASE_URL` for consistency with the Ollama clients Pi /
 * Opencode use.
 */
export function buildAgentApiKeyEnv(
  host: ConciergeDepsHost,
): Record<string, string> {
  const env: Record<string, string> = {};
  // Resolve each backend's effective key (stored > env) and emit
  // under the standard env name those CLIs look for.
  const emit = (
    backend: ConciergeBackend,
    standardEnvName: string,
  ): void => {
    const cfg = BACKEND_CONFIGS[backend];
    const storedKey = host.settings.get<string>(cfg.keySetting, '').trim();
    const envKey = readEnvFirst(cfg.envKeys);
    const key = storedKey || envKey;
    if (key) env[standardEnvName] = key;
  };
  emit('openrouter', 'OPENROUTER_API_KEY');
  emit('anthropic', 'ANTHROPIC_API_KEY');
  emit('openai', 'OPENAI_API_KEY');
  emit('groq', 'GROQ_API_KEY');
  emit('ollama', 'OLLAMA_BASE_URL');
  return env;
}

export function readBackend(
  host: Pick<ConciergeDepsHost, 'settings'>,
): ConciergeBackend {
  const raw = host.settings.get<string>('concierge.backend', DEFAULT_BACKEND);
  // Allowlist mirrors the `ConciergeBackend` union — adding a backend
  // means one more entry here AND in BACKEND_CONFIGS /
  // BACKEND_FACTORIES. Forgetting this row silently downgrades the
  // user's selection to DEFAULT_BACKEND (the bug ollama caught on
  // first wire-up).
  return raw === 'openrouter' ||
    raw === 'groq' ||
    raw === 'ollama' ||
    raw === 'openai' ||
    raw === 'anthropic'
    ? raw
    : DEFAULT_BACKEND;
}

export function readConfiguredProvider(
  host: ConciergeDepsHost,
): ConfiguredProvider {
  const backend = readBackend(host);
  const cfg = BACKEND_CONFIGS[backend];
  const storedKey = host.settings.get<string>(cfg.keySetting, '');
  const envKey = readEnvFirst(cfg.envKeys);
  // No hardcoded fallback (2026-04-26): empty stored → empty model →
  // provider returns a clear "model required" error → user fills it in.
  // Better than shipping a stale default that 404s.
  const model = host.settings.get<string>(cfg.modelSetting, '');
  return {
    backend,
    key: storedKey || envKey,
    storedKey,
    envConfigured: !storedKey && envKey.length > 0,
    model,
  };
}

export function readProviderModel(
  host: ConciergeDepsHost,
): { provider: LLMProvider; model: string } {
  const configured = readConfiguredProvider(host);
  // Test-only escape hatch — if the harness wired a provider directly
  // into the concierge bag, use it. Production never sets this.
  if (host.concierge.providerOverride) {
    return { provider: host.concierge.providerOverride, model: configured.model };
  }
  // Ollama is unique: no API key, just a base URL. Empty stored value
  // means "use the default localhost endpoint" — that's a valid config,
  // not a missing one. Factory below tolerates an empty string. For
  // groq/openrouter the absence of a key means "Mo not configured" →
  // Noop.
  if (configured.backend !== 'ollama' && !configured.key) {
    return { provider: new NoopLLMProvider(), model: configured.model };
  }
  try {
    const factory = BACKEND_FACTORIES[configured.backend];
    return { provider: factory(configured.key), model: configured.model };
  } catch {
    return { provider: new NoopLLMProvider(), model: configured.model };
  }
}

/**
 * Per-backend chat-tier fallback. `completeWithFallback` retries once
 * on the same provider with this model id when the primary chat model
 * fails. The id MUST be one THIS backend understands — sending
 * OpenRouter's id shape to api.openai.com 404s.
 *
 * Empty (default) → no retry. User can opt in per backend by setting
 * `concierge.<backend>_chat_model_fallback`. Out-of-the-box behavior
 * is "primary fails → user sees the primary error" — clearer signal
 * than a silent retry on a stale default that also fails.
 */
export function readChatModelFallback(host: ConciergeDepsHost): string {
  const backend = readBackend(host);
  const cfg = BACKEND_CONFIGS[backend];
  return host.settings.get<string>(cfg.chatFallbackModelSetting, '');
}

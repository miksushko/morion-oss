/**
 * Backend config table — per-backend setting keys ONLY. No hardcoded
 * model IDs (2026-04-26): vendors ship new models monthly and our
 * shipped defaults go stale fast. The user picks the model on first
 * configuration; the UI placeholder shows a current suggestion as
 * informational typing-aid only (defined in
 * `src/web/src/components/MoProviderKeySection.tsx`'s `DEFAULTS`).
 *
 * Empty stored model → server reads `''` → provider call fails with a
 * vendor-clear "model required" error, surfaced to the user, who fills
 * it in. Better than silently shipping an outdated id that 404s on
 * every chat turn.
 *
 * The chat-fallback / brief-tier model settings work the same way —
 * empty until user fills in. When the chat fallback equals the
 * primary or is empty, `completeWithFallback` skips the retry. When
 * the brief model is empty, the brief digest skips for that backend.
 *
 * Adding a new backend is one row in `BACKEND_CONFIGS` + one row in
 * `BACKEND_FACTORIES` + one allowlist entry in `readBackend`; nothing
 * else changes. Per the CLAUDE.md backend-addition lesson.
 */
import {
  AnthropicProvider,
  DEFAULT_OLLAMA_BASE_URL,
  GroqProvider,
  OllamaProvider,
  OpenAIProvider,
  OpenRouterProvider,
  type LLMProvider,
} from '../../../core/concierge/index.js';
import type { BackendConfig, ConciergeBackend } from './types.js';

export const DEFAULT_BACKEND: ConciergeBackend = 'groq';

export const BACKEND_CONFIGS: Record<ConciergeBackend, BackendConfig> = {
  groq: {
    keySetting: 'concierge.groq_api_key',
    envKeys: ['MORION_GROQ_API_KEY', 'GROQ_API_KEY', 'GROQ_KEY'],
    modelSetting: 'concierge.groq_model',
    chatFallbackModelSetting: 'concierge.groq_chat_model_fallback',
    briefModelSetting: 'concierge.groq_brief_model',
    briefFallbackModelSetting: 'concierge.groq_brief_model_fallback',
  },
  openrouter: {
    keySetting: 'concierge.openrouter_api_key',
    envKeys: ['MORION_OPENROUTER_API_KEY', 'OPEN_ROUTER_KEY'],
    modelSetting: 'concierge.openrouter_model',
    chatFallbackModelSetting: 'concierge.openrouter_chat_model_fallback',
    briefModelSetting: 'concierge.openrouter_brief_model',
    briefFallbackModelSetting: 'concierge.openrouter_brief_model_fallback',
  },
  // Ollama treats `keySetting` as the BASE URL (no API key needed for
  // local inference). Reusing the same field shape lets readConfigured-
  // Provider stay one code path; the factory + UI know to interpret it
  // as a URL not a secret. Empty stored value → fall through to env →
  // fall through to DEFAULT_OLLAMA_BASE_URL (`http://127.0.0.1:11434`).
  ollama: {
    keySetting: 'concierge.ollama_base_url',
    envKeys: ['MORION_OLLAMA_BASE_URL', 'OLLAMA_BASE_URL'],
    modelSetting: 'concierge.ollama_model',
    chatFallbackModelSetting: 'concierge.ollama_chat_model_fallback',
    briefModelSetting: 'concierge.ollama_brief_model',
    briefFallbackModelSetting: 'concierge.ollama_brief_model_fallback',
  },
  // Direct OpenAI / Anthropic — same shape as groq/openrouter (API
  // key + per-backend model), different endpoints + auth headers
  // handled inside the provider classes themselves. Env fallbacks
  // mirror the names the official SDKs read so a user with
  // `OPENAI_API_KEY` already in their shell gets Mo wired automatically.
  openai: {
    keySetting: 'concierge.openai_api_key',
    envKeys: ['MORION_OPENAI_API_KEY', 'OPENAI_API_KEY'],
    modelSetting: 'concierge.openai_model',
    chatFallbackModelSetting: 'concierge.openai_chat_model_fallback',
    briefModelSetting: 'concierge.openai_brief_model',
    briefFallbackModelSetting: 'concierge.openai_brief_model_fallback',
  },
  anthropic: {
    keySetting: 'concierge.anthropic_api_key',
    envKeys: ['MORION_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
    modelSetting: 'concierge.anthropic_model',
    chatFallbackModelSetting: 'concierge.anthropic_chat_model_fallback',
    briefModelSetting: 'concierge.anthropic_brief_model',
    briefFallbackModelSetting: 'concierge.anthropic_brief_model_fallback',
  },
};

export const BACKEND_FACTORIES: Record<
  ConciergeBackend,
  (key: string) => LLMProvider
> = {
  groq: (key) => new GroqProvider(key),
  openrouter: (key) => new OpenRouterProvider(key),
  // For ollama the "key" param is actually the base URL (or '' to use
  // DEFAULT_OLLAMA_BASE_URL). No secret to validate — the constructor
  // stores it and `complete()` POSTs to `${baseUrl}/v1/chat/completions`.
  ollama: (baseUrl) =>
    new OllamaProvider({ baseUrl: baseUrl || DEFAULT_OLLAMA_BASE_URL }),
  openai: (key) => new OpenAIProvider(key),
  anthropic: (key) => new AnthropicProvider(key),
};

export function readEnvFirst(names: readonly string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.length > 0) return v;
  }
  return '';
}

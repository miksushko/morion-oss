import { describe, it, expect } from 'vitest';
import { resolveMoIndexingProvider } from '../src/server/features/concierge-deps/index.js';
import {
  MO_INDEXING_TIER1_MODEL,
  MO_INDEXING_TIER2_MODEL,
  MO_INDEXING_TIER1_FALLBACK,
  MO_INDEXING_TIER2_FALLBACK,
} from '../src/core/concierge/mo-indexing-tick';

/**
 * Verifies the Phase 3.5+ migration: per-backend tier1 / tier2 / topic-hygiene
 * settings are READ by resolveMoIndexingProvider when stored, and fall back
 * to the hardcoded constants when empty.
 *
 * Without this test, the UI fields could autosave-PUT but the indexing tick
 * would still call hardcoded mistral-nemo / qwen-235b — making the whole
 * feature a lie.
 */

interface MockSettings {
  data: Record<string, unknown>;
}
function mockHost(settings: Record<string, unknown>) {
  // Minimal duck-typed host — only `concierge` + `settings.get` are touched
  // by resolveMoIndexingProvider's read paths.
  const data: Record<string, unknown> = {
    'concierge.backend': 'openrouter',
    'concierge.openrouter_api_key': 'sk-or-test',
    ...settings,
  };
  return {
    settings: {
      get: <T,>(key: string, fallback?: T): T =>
        (key in data ? (data[key] as T) : (fallback as T)),
    },
    concierge: { providerOverride: undefined },
  } as unknown as Parameters<typeof resolveMoIndexingProvider>[0];
}

describe('resolveMoIndexingProvider — pipeline overrides', () => {
  it('returns hardcoded constants when no overrides stored', () => {
    const r = resolveMoIndexingProvider(mockHost({}));
    expect(r).not.toBeNull();
    expect(r!.tier1Model).toBe(MO_INDEXING_TIER1_MODEL);
    expect(r!.tier1FallbackModel).toBe(MO_INDEXING_TIER1_FALLBACK);
    expect(r!.tier2Model).toBe(MO_INDEXING_TIER2_MODEL);
    expect(r!.tier2FallbackModel).toBe(MO_INDEXING_TIER2_FALLBACK);
  });

  it('honours stored Tier 1 override', () => {
    const r = resolveMoIndexingProvider(
      mockHost({ 'concierge.openrouter_tier1_model': 'custom-tier1-model' }),
    );
    expect(r!.tier1Model).toBe('custom-tier1-model');
    expect(r!.tier1FallbackModel).toBe(MO_INDEXING_TIER1_FALLBACK);
  });

  it('honours stored Tier 2 override + cascades to topic-hygiene fallback', () => {
    const r = resolveMoIndexingProvider(
      mockHost({ 'concierge.openrouter_tier2_model': 'custom-tier2-model' }),
    );
    expect(r!.tier2Model).toBe('custom-tier2-model');
    // Topic hygiene falls back to tier2Model when its own setting is empty.
    expect(r!.topicHygieneModel).toBe('custom-tier2-model');
  });

  it('honours stored topic-hygiene override (independent of tier2)', () => {
    const r = resolveMoIndexingProvider(
      mockHost({
        'concierge.openrouter_topic_hygiene_model': 'deepseek-custom',
      }),
    );
    expect(r!.topicHygieneModel).toBe('deepseek-custom');
    expect(r!.tier2Model).toBe(MO_INDEXING_TIER2_MODEL);
  });

  it('honours stored fallbacks for tier1 / tier2', () => {
    const r = resolveMoIndexingProvider(
      mockHost({
        'concierge.openrouter_tier1_model_fallback': 'custom-tier1-fb',
        'concierge.openrouter_tier2_model_fallback': 'custom-tier2-fb',
      }),
    );
    expect(r!.tier1FallbackModel).toBe('custom-tier1-fb');
    expect(r!.tier2FallbackModel).toBe('custom-tier2-fb');
  });
});

describe('resolveMoIndexingProvider — non-OpenRouter backends', () => {
  // Non-OpenRouter backends have NO built-in model defaults: tier1 + tier2
  // must be set explicitly. Without them the resolver returns null even
  // when a key is configured (surfaces as mo_provider_unconfigured).
  function openaiHost(extra: Record<string, unknown>) {
    const data: Record<string, unknown> = {
      'concierge.backend': 'openai',
      'concierge.openai_api_key': 'sk-test-openai',
      ...extra,
    };
    return {
      settings: {
        get: <T,>(key: string, fallback?: T): T =>
          key in data ? (data[key] as T) : (fallback as T),
      },
      concierge: { providerOverride: undefined },
    } as unknown as Parameters<typeof resolveMoIndexingProvider>[0];
  }

  it('returns null when tier1 / tier2 are unset (no built-in defaults)', () => {
    expect(resolveMoIndexingProvider(openaiHost({}))).toBeNull();
  });

  it('returns null with only tier1 set (tier2 still missing)', () => {
    expect(
      resolveMoIndexingProvider(
        openaiHost({ 'concierge.openai_tier1_model': 'gpt-4o-mini' }),
      ),
    ).toBeNull();
  });

  it('resolves once tier1 + tier2 are both set; no hardcoded OR ids leak', () => {
    const r = resolveMoIndexingProvider(
      openaiHost({
        'concierge.openai_tier1_model': 'gpt-4o-mini',
        'concierge.openai_tier2_model': 'gpt-4o',
      }),
    );
    expect(r).not.toBeNull();
    expect(r!.tier1Model).toBe('gpt-4o-mini');
    expect(r!.tier2Model).toBe('gpt-4o');
    // Empty fallbacks → single-attempt mode (null, not an OpenRouter id).
    expect(r!.tier1FallbackModel).toBeNull();
    expect(r!.tier2FallbackModel).toBeNull();
    // Topic hygiene falls back to the resolved tier2 model.
    expect(r!.topicHygieneModel).toBe('gpt-4o');
  });

  it('returns null when the API key is missing', () => {
    const r = resolveMoIndexingProvider(
      openaiHost({
        'concierge.openai_api_key': '',
        'concierge.openai_tier1_model': 'gpt-4o-mini',
        'concierge.openai_tier2_model': 'gpt-4o',
      }),
    );
    expect(r).toBeNull();
  });
});

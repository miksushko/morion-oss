/**
 * Regression: chat + brief fallback model ids used to be a single
 * workspace-wide setting (`concierge.chat_model_fallback`,
 * `concierge.brief_model`, `concierge.brief_model_fallback`) defaulting
 * to OpenRouter ids (`qwen3.6-plus`, `qwen/qwen3.5-flash-02-23`,
 * `deepseek/deepseek-v4-flash`). When a user switched the active
 * backend to OpenAI / Anthropic, those OpenRouter-shaped ids got sent
 * to api.openai.com / api.anthropic.com and 404'd:
 *
 *   "Mo error: OpenAI 404: The model qwen3.6-plus does not exist…"
 *
 * First-pass fix tried to ship per-backend hardcoded defaults. Second-
 * pass fix (2026-04-26) DROPPED those defaults entirely: vendor model
 * IDs change monthly, our shipped defaults go stale fast. The user
 * picks the model on first configuration via per-backend setting keys
 * (`concierge.<backend>_model`, `concierge.<backend>_chat_model_fallback`,
 * `concierge.<backend>_brief_model`, `..._brief_model_fallback`).
 * Empty stored → empty resolved → fallback retry skipped, brief tier
 * disabled. The UI placeholder shows recommended ids as a typing aid
 * only.
 *
 * Ticket `01KQ2ZZ969G4RCC20C67M5SJV2` follow-up.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import { SettingsRepository } from '../src/core/settings/repository.js';
import {
  readChatModelFallback,
  readConfiguredProvider,
  type ConciergeDepsHost,
  type ConciergeBackend,
} from '../src/server/features/concierge-deps/index.js';
import {
  BudgetTracker,
  MoSpendLedgerRepository,
} from '../src/core/concierge/index.js';

function makeHost(settings: SettingsRepository, db?: DbHandle): ConciergeDepsHost {
  // For tests that exercise the brief-deps wire, a real BudgetTracker
  // backed by an in-memory ledger lets us assert `deps.budget` is the
  // SAME instance the host carries — verifying the wire, not just
  // a stubbed truthy value.
  const ledger = db ? new MoSpendLedgerRepository(db.db) : (undefined as never);
  const budget = db ? new BudgetTracker(ledger) : (undefined as never);
  return {
    db: db ? db.db : (undefined as never),
    notes: undefined as never,
    folders: undefined as never,
    comments: undefined as never,
    settings,
    concierge: {
      folderSettings: undefined as never,
      sessions: undefined as never,
      messages: undefined as never,
      actions: undefined as never,
      folderBriefs: undefined as never,
      moMemory: undefined as never,
      budget,
    },
  };
}

const ALL_BACKENDS: ConciergeBackend[] = [
  'groq',
  'openrouter',
  'ollama',
  'openai',
  'anthropic',
];

describe('Per-backend chat fallback (readChatModelFallback)', () => {
  let handle: DbHandle;
  let settings: SettingsRepository;

  beforeEach(() => {
    handle = openDb({ path: ':memory:' });
    settings = new SettingsRepository(handle.db);
  });

  afterEach(() => {
    handle.db.close();
  });

  for (const backend of ALL_BACKENDS) {
    it(`backend=${backend} → empty default (no hardcoded model id ships)`, () => {
      settings.set('concierge.backend', backend);
      const host = makeHost(settings);
      expect(readChatModelFallback(host)).toBe('');
    });

    it(`backend=${backend} respects per-backend stored override`, () => {
      settings.set('concierge.backend', backend);
      settings.set(`concierge.${backend}_chat_model_fallback`, 'custom-model-id');
      const host = makeHost(settings);
      expect(readChatModelFallback(host)).toBe('custom-model-id');
    });
  }

  it('OpenAI active backend does NOT inherit OpenRouter fallback (regression)', () => {
    // The exact bug: user on OpenAI with chat_model_fallback unset
    // would receive `qwen3.6-plus` → 404 on api.openai.com. Now empty
    // (no retry) — primary error surfaces directly to the user.
    settings.set('concierge.backend', 'openai');
    const host = makeHost(settings);
    expect(readChatModelFallback(host)).toBe('');
  });

  it('a vendor-shaped fallback set under one backend does NOT bleed to another', () => {
    // User configures OpenRouter with a fallback, then switches to
    // OpenAI without configuring fallback there. The OpenRouter
    // fallback must NOT travel — that was the original bug class.
    settings.set('concierge.openrouter_chat_model_fallback', 'qwen3.6-plus');
    settings.set('concierge.backend', 'openai');
    const host = makeHost(settings);
    expect(readChatModelFallback(host)).toBe(''); // empty, NOT qwen
  });
});

describe('readConfiguredProvider — model resolution', () => {
  let handle: DbHandle;
  let settings: SettingsRepository;

  beforeEach(() => {
    handle = openDb({ path: ':memory:' });
    settings = new SettingsRepository(handle.db);
  });

  afterEach(() => {
    handle.db.close();
  });

  for (const backend of ALL_BACKENDS) {
    it(`backend=${backend} ships NO hardcoded model default`, () => {
      settings.set('concierge.backend', backend);
      const host = makeHost(settings);
      const configured = readConfiguredProvider(host);
      expect(configured.model).toBe('');
    });

    it(`backend=${backend} respects stored model`, () => {
      settings.set('concierge.backend', backend);
      settings.set(`concierge.${backend}_model`, 'user-typed-model');
      const host = makeHost(settings);
      const configured = readConfiguredProvider(host);
      expect(configured.model).toBe('user-typed-model');
    });
  }
});


import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import {
  SettingsRepository,
  SETTINGS_KEYS,
  TOOL_CATEGORIES,
} from '../src/core/settings/repository.js';

/**
 * Repo round-trip + default-on contract for the settings table.
 *
 * The MCP gating wrapper relies on two non-obvious guarantees here:
 *   1. A fresh DB (zero rows in `settings`) reports the MCP server enabled and
 *      every category enabled, because the *getter* supplies defaults — we
 *      never INSERT defaults at migration time.
 *   2. A row with malformed JSON falls back to the default instead of
 *      crashing the MCP child. This is the recovery path for a manual
 *      sqlite3 edit gone wrong.
 */

interface Ctx {
  handle: DbHandle;
  settings: SettingsRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  return { handle, settings: new SettingsRepository(handle.db) };
}

describe('SettingsRepository', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('returns default-on MCP settings on a fresh DB', () => {
    const mcp = ctx.settings.getMcpSettings();
    expect(mcp.enabled).toBe(true);
    for (const cat of TOOL_CATEGORIES) {
      expect(mcp.categories[cat]).toBe(true);
    }
  });

  it('round-trips primitives and objects through get/set', () => {
    ctx.settings.set('flag', true);
    ctx.settings.set('count', 42);
    ctx.settings.set('name', 'morion');
    ctx.settings.set('shape', { a: 1, b: ['x', 'y'] });

    expect(ctx.settings.get('flag', false)).toBe(true);
    expect(ctx.settings.get('count', 0)).toBe(42);
    expect(ctx.settings.get('name', '')).toBe('morion');
    expect(ctx.settings.get<{ a: number; b: string[] }>('shape', { a: 0, b: [] })).toEqual({
      a: 1,
      b: ['x', 'y'],
    });
  });

  it('overwrites existing keys via upsert', () => {
    ctx.settings.set('flag', true);
    ctx.settings.set('flag', false);
    expect(ctx.settings.get('flag', true)).toBe(false);
  });

  it('returns the supplied default when the key is missing', () => {
    expect(ctx.settings.get('nope', 'fallback')).toBe('fallback');
    expect(ctx.settings.get('nope', 7)).toBe(7);
  });

  it('falls back to the default when stored JSON is malformed', () => {
    ctx.handle.db
      .prepare('INSERT INTO settings(key, value) VALUES(?, ?)')
      .run('broken', 'not-json{');
    expect(ctx.settings.get('broken', 'safe')).toBe('safe');
  });

  it('getAll returns every parseable row', () => {
    ctx.settings.set('a', 1);
    ctx.settings.set('b', 'two');
    ctx.settings.set('c', { ok: true });
    const all = ctx.settings.getAll();
    expect(all).toEqual({ a: 1, b: 'two', c: { ok: true } });
  });

  it('getAll skips unparseable rows instead of throwing', () => {
    ctx.settings.set('good', 1);
    ctx.handle.db
      .prepare('INSERT INTO settings(key, value) VALUES(?, ?)')
      .run('bad', '}{');
    const all = ctx.settings.getAll();
    expect(all).toEqual({ good: 1 });
  });

  it('setMcpEnabled flips the enabled flag', () => {
    ctx.settings.setMcpEnabled(false);
    expect(ctx.settings.getMcpSettings().enabled).toBe(false);
    ctx.settings.setMcpEnabled(true);
    expect(ctx.settings.getMcpSettings().enabled).toBe(true);
  });

  it('setMcpCategory toggles only the requested category', () => {
    ctx.settings.setMcpCategory('delete', false);
    const mcp = ctx.settings.getMcpSettings();
    expect(mcp.categories.delete).toBe(false);
    expect(mcp.categories.read).toBe(true);
    expect(mcp.categories.create).toBe(true);
    expect(mcp.categories.update).toBe(true);
  });

  it('writes setMcpCategory under the canonical SETTINGS_KEYS namespace', () => {
    ctx.settings.setMcpCategory('read', false);
    const row = ctx.handle.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEYS.mcpCategoryRead) as { value: string } | undefined;
    expect(row?.value).toBe('false');
  });

  it('getTerms returns null/null on a fresh DB', () => {
    const terms = ctx.settings.getTerms();
    expect(terms.acceptedAt).toBeNull();
    expect(terms.version).toBeNull();
  });

  it('acceptTerms persists both the timestamp and the version together', () => {
    const before = Date.now();
    ctx.settings.acceptTerms('2026-04-19');
    const terms = ctx.settings.getTerms();
    expect(terms.version).toBe('2026-04-19');
    expect(typeof terms.acceptedAt).toBe('number');
    expect(terms.acceptedAt!).toBeGreaterThanOrEqual(before);
    expect(terms.acceptedAt!).toBeLessThanOrEqual(Date.now() + 10);
  });

  it('acceptTerms overwrites a prior acceptance when called again', () => {
    ctx.settings.acceptTerms('2026-01-01');
    const first = ctx.settings.getTerms().acceptedAt!;
    // Small delay so the second timestamp is distinct from the first.
    const target = first + 1;
    while (Date.now() <= target) {
      // busy-loop one ms — cheap and deterministic in tests
    }
    ctx.settings.acceptTerms('2026-04-19');
    const second = ctx.settings.getTerms();
    expect(second.version).toBe('2026-04-19');
    expect(second.acceptedAt!).toBeGreaterThan(first);
  });
});

import { describe, expect, it } from 'vitest';

import { applyClaudeLevelIdiom } from '../src/core/auto-code/harness/adapters/claude.js';
import { mapCodexLevel } from '../src/core/auto-code/harness/adapters/codex.js';

/**
 * Phase 4 follow-ups (2026-05-11) — Workflow Editor v2 `cli_agent.level`
 * mapping per adapter. Pins the mapping each adapter applies so the
 * silent-drop regression Codex flagged stays caught.
 */

describe('applyClaudeLevelIdiom — Claude level → think-idiom prompt prefix', () => {
  it('Default returns prompt unchanged', () => {
    expect(applyClaudeLevelIdiom('do the thing', 'Default')).toBe('do the thing');
  });
  it('undefined returns prompt unchanged', () => {
    expect(applyClaudeLevelIdiom('do the thing', undefined)).toBe('do the thing');
  });
  it('Think prepends "think" on its own line', () => {
    expect(applyClaudeLevelIdiom('do the thing', 'Think')).toBe(
      'think\n\ndo the thing',
    );
  });
  it('ThinkHard prepends "think hard"', () => {
    expect(applyClaudeLevelIdiom('do the thing', 'ThinkHard')).toBe(
      'think hard\n\ndo the thing',
    );
  });
  it('ThinkHarder prepends "think harder"', () => {
    expect(applyClaudeLevelIdiom('do the thing', 'ThinkHarder')).toBe(
      'think harder\n\ndo the thing',
    );
  });
  it('Ultrathink prepends "ultrathink"', () => {
    expect(applyClaudeLevelIdiom('do the thing', 'Ultrathink')).toBe(
      'ultrathink\n\ndo the thing',
    );
  });
  it('unrecognised level falls through with no prefix (avoid silent behaviour change)', () => {
    expect(applyClaudeLevelIdiom('do the thing', 'WizardMode')).toBe('do the thing');
  });
});

describe('mapCodexLevel — Codex level → --reasoning-effort value', () => {
  it('returns undefined for Default / blank', () => {
    expect(mapCodexLevel('Default')).toBeUndefined();
    expect(mapCodexLevel(undefined)).toBeUndefined();
    expect(mapCodexLevel('')).toBeUndefined();
  });
  it('maps Low / Medium / High case-insensitively', () => {
    expect(mapCodexLevel('Low')).toBe('low');
    expect(mapCodexLevel('low')).toBe('low');
    expect(mapCodexLevel('Medium')).toBe('medium');
    expect(mapCodexLevel('High')).toBe('high');
  });
  it('returns undefined for unrecognised input', () => {
    expect(mapCodexLevel('Ultra')).toBeUndefined();
    expect(mapCodexLevel('Think')).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { setup, type Ctx } from '../helpers/mo-memory-setup.js';

describe('MoMemoryRepository', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns empty string when unset (stable contract — callers don\'t null-check)', () => {
    expect(ctx.memory.read()).toBe('');
  });

  it('write + read round-trip preserves markdown verbatim', () => {
    const body = '## Preferences\n- User likes structured postmortems\n\n## Decisions\n- DuckDB over ClickHouse';
    ctx.memory.write(body);
    expect(ctx.memory.read()).toBe(body);
  });

  it('appendSection on empty memory creates the first section', () => {
    const result = ctx.memory.appendSection('Preferences', '- User likes terse answers');
    expect(result).toBe('## Preferences\n- User likes terse answers');
    expect(ctx.memory.read()).toBe(result);
  });

  it('appendSection on existing memory adds a new section with separator', () => {
    ctx.memory.write('## Preferences\n- terse answers');
    const result = ctx.memory.appendSection('Decisions', '- DuckDB picked');
    expect(result).toContain('## Preferences');
    expect(result).toContain('## Decisions');
    expect(result).toContain('\n\n## Decisions');
  });
});

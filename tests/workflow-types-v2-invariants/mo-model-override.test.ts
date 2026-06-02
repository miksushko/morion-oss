import { describe, it, expect } from 'vitest';
import { MoModelOverrideSchema } from '../../src/core/auto-code/workflows/types/index.js';

describe('MoModelOverrideSchema discriminated union', () => {
  it('accepts { useDefault: true } alone', () => {
    expect(() => MoModelOverrideSchema.parse({ useDefault: true })).not.toThrow();
  });

  it('rejects override fields alongside useDefault=true (silent-ignore trap)', () => {
    expect(() =>
      MoModelOverrideSchema.parse({ useDefault: true, level: 'High' }),
    ).toThrow();
  });

  it('accepts { useDefault: false } with override fields', () => {
    expect(() =>
      MoModelOverrideSchema.parse({
        useDefault: false,
        tool: 'claude',
        level: 'Ultrathink',
      }),
    ).not.toThrow();
  });

  it('accepts { useDefault: false } with all override fields omitted', () => {
    // Per spec: each override field is independently optional — user might
    // want "default everything except level=High".
    expect(() => MoModelOverrideSchema.parse({ useDefault: false })).not.toThrow();
  });
});

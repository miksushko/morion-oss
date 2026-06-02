import { describe, it, expect } from 'vitest';
import { hashBody } from '../../src/core/concierge/index.js';

describe('hashBody', () => {
  it('returns the same hash for the same body', () => {
    const a = hashBody('hello');
    const b = hashBody('hello');
    expect(a).toBe(b);
  });
  it('returns a different hash for different bodies', () => {
    expect(hashBody('a')).not.toBe(hashBody('b'));
  });
  it('returns a 64-char hex string (sha256)', () => {
    expect(hashBody('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

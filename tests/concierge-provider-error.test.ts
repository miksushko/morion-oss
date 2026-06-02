/**
 * Regression: Mo chat error messages used to surface as bare
 * "fetch failed" when a network-level provider call collapsed. The
 * actual cause (DNS not warm post-wake, TLS clock skew, connection
 * refused, etc.) sat on Node's `err.cause` and was thrown away by the
 * route's `(err as Error).message.slice(0, 200)` snippet.
 *
 * 2026-04-25 incident: user rebooted, opened Mo chat, got "Mo error:
 * fetch failed" with no actionable signal. `describeProviderError`
 * peels `err.cause` for { code, hostname } and surfaces them in the
 * user-visible message.
 */
import { describe, it, expect } from 'vitest';
import { describeProviderError } from '../src/core/concierge/provider.js';

describe('describeProviderError', () => {
  it('plain string error → unchanged message', () => {
    expect(describeProviderError(new Error('boom'))).toBe('boom');
  });

  it('Node fetch with DNS cause → ENOTFOUND + hostname surfaces', () => {
    // Mirrors what undici throws for a DNS miss on api.groq.com.
    const err = new Error('fetch failed');
    (err as Error & { cause: unknown }).cause = {
      code: 'ENOTFOUND',
      hostname: 'api.groq.com',
      message: 'getaddrinfo ENOTFOUND api.groq.com',
    };
    expect(describeProviderError(err)).toBe('fetch failed (ENOTFOUND api.groq.com)');
  });

  it('Node fetch with connection refused → ECONNREFUSED surfaces', () => {
    const err = new Error('fetch failed');
    (err as Error & { cause: unknown }).cause = {
      code: 'ECONNREFUSED',
      message: 'connect ECONNREFUSED 127.0.0.1:443',
    };
    // No hostname on this cause shape — message is the second-best signal.
    const msg = describeProviderError(err);
    expect(msg).toContain('fetch failed');
    expect(msg).toContain('ECONNREFUSED');
  });

  it('cause without code or hostname falls back to its message', () => {
    const err = new Error('fetch failed');
    (err as Error & { cause: unknown }).cause = {
      message: 'socket hang up',
    };
    expect(describeProviderError(err)).toBe('fetch failed (socket hang up)');
  });

  it('cause with the same message as the outer error → no duplicate', () => {
    const err = new Error('fetch failed');
    (err as Error & { cause: unknown }).cause = {
      message: 'fetch failed',
    };
    // Avoid "fetch failed (fetch failed)" noise.
    expect(describeProviderError(err)).toBe('fetch failed');
  });

  it('non-Error thrown → stringified', () => {
    expect(describeProviderError('plain string')).toBe('plain string');
    expect(describeProviderError(42)).toBe('42');
  });

  it('undefined cause → bare message', () => {
    const err = new Error('upstream 503');
    expect(describeProviderError(err)).toBe('upstream 503');
  });
});

import { describe, expect, it } from 'vitest';
import { fallbackAcceptedTerms, needsTermsConsent } from '../src/web/src/lib/termsGate.js';

describe('first-run terms gate fallback', () => {
  it('does not show consent again after settings fetch fallback', () => {
    expect(needsTermsConsent(fallbackAcceptedTerms())).toBe(false);
  });

  it('still requires consent when no accepted version is stored', () => {
    expect(
      needsTermsConsent({
        current: '2026-04-19',
        acceptedAt: null,
        acceptedVersion: null,
      }),
    ).toBe(true);
  });
});

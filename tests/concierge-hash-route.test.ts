/**
 * Regression: the "Open chat to reply" button inside the
 * PausedAskUserCTA banner (AutoCodeDrawer) was a silent no-op since
 * it shipped. It writes `window.location.hash = '#/concierge[/sessions/<id>]'`
 * but no part of the app listened for that hash. The drawer is three
 * component layers below App, so prop-drilling a chat-navigation
 * callback would touch ~5 files; the hash-based intent is fine — it
 * just needed a translator. `useConciergeHashRoute` is that
 * translator; `parseConciergeHash` is the pure half this test pins.
 */
import { describe, it, expect } from 'vitest';
import { parseConciergeHash } from '../src/web/src/hooks/useConciergeHashRoute';

describe('parseConciergeHash (01KRWSM9HET3T3MQTMB7AXRDXY follow-up)', () => {
  it('routes bare #/concierge', () => {
    expect(parseConciergeHash('#/concierge')).toEqual({ view: 'concierge' });
  });

  it('routes #/concierge/ (trailing slash tolerated)', () => {
    expect(parseConciergeHash('#/concierge/')).toEqual({ view: 'concierge' });
  });

  it('routes #/concierge/sessions/<id> with ULID', () => {
    expect(parseConciergeHash('#/concierge/sessions/01KRRP2FB0M0HH0JC7PQ2PPDS2')).toEqual({
      view: 'concierge',
      sessionId: '01KRRP2FB0M0HH0JC7PQ2PPDS2',
    });
  });

  it('routes #/concierge/sessions/<id> with cs_-prefixed id', () => {
    expect(parseConciergeHash('#/concierge/sessions/cs_test_abc-123')).toEqual({
      view: 'concierge',
      sessionId: 'cs_test_abc-123',
    });
  });

  it('returns null for unrelated hashes', () => {
    expect(parseConciergeHash('')).toBeNull();
    expect(parseConciergeHash('#/notes')).toBeNull();
    expect(parseConciergeHash('#/concierge/extra/junk')).toBeNull();
    expect(parseConciergeHash('#concierge')).toBeNull();
  });

  it('rejects empty session segment', () => {
    expect(parseConciergeHash('#/concierge/sessions/')).toBeNull();
  });
});

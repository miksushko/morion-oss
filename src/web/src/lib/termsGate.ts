import type { TermsInfo } from './api';

const SETTINGS_FETCH_FAILED_VERSION = '__settings_fetch_failed__';

/**
 * If /api/settings is unreachable, do not strand the user on a consent
 * screen whose Accept button can only hit the same unreachable server.
 * The app still cannot persist consent until the sidecar works again,
 * but this state matches App.tsx's existing "render the shell" fallback.
 */
export function fallbackAcceptedTerms(): TermsInfo {
  return {
    current: SETTINGS_FETCH_FAILED_VERSION,
    acceptedAt: 0,
    acceptedVersion: SETTINGS_FETCH_FAILED_VERSION,
  };
}

export function needsTermsConsent(terms: TermsInfo): boolean {
  return !terms.acceptedVersion || terms.acceptedVersion < terms.current;
}

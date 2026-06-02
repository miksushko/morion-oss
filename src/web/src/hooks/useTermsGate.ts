import { useCallback, useEffect, useState } from 'react';
import { api, type TermsInfo } from '../lib/api';
import { fallbackAcceptedTerms } from '../lib/termsGate';

/**
 * First-run Terms consent state (ticket 01KPJF12ZJYZXJX2CQ7ACHZF60).
 *
 * `termsInfo === null` means the fetch is still in flight — callers
 * should render a blank splash rather than the main UI or the consent
 * screen (avoids a flash of authenticated UI before the user has
 * accepted). Once loaded, `needsTermsConsent(termsInfo)` decides
 * whether to render `<FirstRunConsent />` instead of the main shell.
 *
 * If the settings endpoint is unreachable, fall back to a synthetic
 * "accepted" value — the app MUST render, and a broken settings
 * endpoint shouldn't lock the user out forever. The server-side
 * accept endpoint validates the posted version, so a spoofed
 * client-side state cannot forge stored consent.
 */
export function useTermsGate(envReady: boolean) {
  const [termsInfo, setTermsInfo] = useState<TermsInfo | null>(null);

  useEffect(() => {
    if (!envReady) return;
    let alive = true;
    api
      .getSettings()
      .then((s) => {
        if (alive) setTermsInfo(s.terms);
      })
      .catch((err) => {
        console.error('terms fetch failed, assuming accepted', err);
        if (alive) setTermsInfo(fallbackAcceptedTerms());
      });
    return () => {
      alive = false;
    };
  }, [envReady]);

  const acceptTerms = useCallback(async () => {
    if (!termsInfo) return;
    const updated = await api.acceptTerms(termsInfo.current);
    setTermsInfo(updated);
  }, [termsInfo]);

  return { termsInfo, acceptTerms };
}

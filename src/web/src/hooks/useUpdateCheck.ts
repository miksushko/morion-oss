import { useCallback, useEffect, useRef } from 'react';
import type { UpdateCheckResult } from '../components/UpdateBanner';

/**
 * Manual + periodic update check wiring. `UpdateBanner` calls
 * `registerCheck` on mount to hand off its check function; `HeaderMenu`
 * / `SettingsDialog` invoke `triggerManualCheck` to drive the same
 * check on demand and surface a toast for the up-to-date / unavailable
 * states (UpdateBanner renders itself for the `available` case).
 *
 * The 4h periodic check covers long-running desktop sessions — Mac
 * users keep apps open for weeks; without this they'd never see new
 * releases until a manual restart. The check is the latest.json HEAD
 * only — download still requires a click in the banner.
 */
export function useUpdateCheck(
  envReady: boolean,
  showToast: (message: string) => void,
) {
  const updateCheckRef = useRef<(() => Promise<UpdateCheckResult>) | null>(null);

  const registerCheck = useCallback((fn: () => Promise<UpdateCheckResult>) => {
    updateCheckRef.current = fn;
  }, []);

  const triggerManualCheck = useCallback(async (): Promise<UpdateCheckResult | null> => {
    if (!updateCheckRef.current) return null;
    const result = await updateCheckRef.current();
    if (result.status === 'up-to-date') {
      showToast('Morion is up to date');
    } else if (result.status === 'unavailable') {
      showToast('Update check failed — try again later');
    }
    return result;
  }, [showToast]);

  useEffect(() => {
    if (!envReady) return;
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    const id = window.setInterval(() => {
      void updateCheckRef.current?.();
    }, FOUR_HOURS_MS);
    return () => window.clearInterval(id);
  }, [envReady]);

  return { registerCheck, triggerManualCheck };
}

/**
 * Pure draft → result validator for the Limits tab's `CapEditor`.
 *
 * Returns the same `{parsed, outOfRange, isKillSwitch}` shape both the
 * input rendering and the debounced autosave consume. Centralising it
 * here keeps the React component free of validation forks and lets us
 * pin the contract in vitest without spinning up JSDom.
 *
 * Rules (lifted verbatim from the legacy inline code):
 *  - Empty / non-numeric / NaN strings → `outOfRange: true`, `parsed: NaN`
 *  - `parsed < 0` or `parsed > maxCap` → `outOfRange: true`
 *  - `parsed === 0` → `isKillSwitch: true`, in-range (cap of zero is a
 *    legal "freeze every paid call" state)
 */
export interface CapValidation {
  parsed: number;
  outOfRange: boolean;
  isKillSwitch: boolean;
}

export function validateCapDraft(draft: string, maxCap: number): CapValidation {
  const parsed = Number.parseFloat(draft);
  if (!Number.isFinite(parsed)) {
    return { parsed: Number.NaN, outOfRange: true, isKillSwitch: false };
  }
  if (parsed < 0 || parsed > maxCap) {
    return { parsed, outOfRange: true, isKillSwitch: parsed === 0 };
  }
  return { parsed, outOfRange: false, isKillSwitch: parsed === 0 };
}

/** Percent (0-100, capped) of `spent` against `cap`. Cap=0 returns 0. */
export function capPercent(spent: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(100, (spent / cap) * 100);
}

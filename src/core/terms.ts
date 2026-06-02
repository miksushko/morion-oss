/**
 * Current Terms of Service + Privacy Policy version, as published on
 * morion.ai. The app compares the user's stored `termsVersion` (written
 * on first-run consent) against this constant and re-prompts when the
 * stored value is older — see `<FirstRunConsent />` + `App.tsx` gate.
 *
 * Bump this string whenever /terms or /privacy receives a material
 * change (per /terms §14 — 30-day notice requirement). Keep it ISO
 * date format `YYYY-MM-DD`; the comparison is lexicographic, which
 * is correct for ISO-8601 dates.
 *
 * Shared between the HTTP server (returned alongside other settings
 * so the frontend knows the target version) and the frontend (gate
 * logic). Single source of truth prevents drift between backend
 * decisions and UI copy.
 */
export const CURRENT_TERMS_VERSION = '2026-04-19';

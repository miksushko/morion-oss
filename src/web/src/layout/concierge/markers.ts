/**
 * Mirrors `NOOP_NOT_CONFIGURED_MARKER` in `src/core/concierge/provider.ts`.
 * Can't cross the core/web boundary (CLAUDE.md architectural rule), so
 * we duplicate the string literal. If this ever drifts the UI falls
 * back to rendering the full paragraph the sentinel is followed by —
 * still readable, just without the CTA button.
 */
export const NOOP_NOT_CONFIGURED_MARKER = '__MO_NOT_CONFIGURED__';

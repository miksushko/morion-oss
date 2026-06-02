import { useState } from 'react';
import { openExternalUrl } from '../lib/openExternalUrl';

/**
 * First-run Terms & Privacy consent gate.
 *
 * Shown by `App.tsx` instead of the main three-pane shell when the user
 * has not yet accepted the current Terms of Service (stored version is
 * null or older than `CURRENT_TERMS_VERSION` from core/terms.ts).
 *
 * Design rules (from ticket 01KPJF12ZJYZXJX2CQ7ACHZF60):
 *   - Full-viewport, opaque — user cannot see or interact with main UI.
 *   - Blocking — the only way out is clicking the primary CTA.
 *   - Legal links open in the system browser (not webview) so the user
 *     can actually read them without losing the consent screen behind
 *     their decision.
 *   - Two variants:
 *       `first-run` — fresh install, introductory tone ("Welcome to
 *         Morion · By continuing you agree…").
 *       `re-consent` — existing install after a Terms version bump
 *         ("We updated our Terms · effective [date]"). Same CTA flow;
 *         the difference is copy + an optional one-liner about what
 *         changed between versions.
 *
 * The component is stateless w.r.t. the main app tree — a parent
 * renders it INSTEAD of the main shell, not on top. That way there's
 * no accidental React-tree leak of main-UI state across consent.
 */

export interface FirstRunConsentProps {
  /** 'first-run' for fresh installs, 're-consent' for version bumps. */
  variant: 'first-run' | 're-consent';
  /** Version string the user will be accepting. Displayed in re-consent
   *  mode as "effective [date]". Posted to the server on Accept. */
  currentVersion: string;
  /** Optional one-liner about what changed since the user's last
   *  accepted version. Only rendered in re-consent mode. */
  changeNote?: string;
  /** Fires when the user clicks Accept. Parent awaits, persists via
   *  `api.acceptTerms(currentVersion)`, then rerenders without this
   *  component. */
  onAccept: () => Promise<void>;
}

export function FirstRunConsent({
  variant,
  currentVersion,
  changeNote,
  onAccept,
}: FirstRunConsentProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAccept = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAccept();
    } catch (err) {
      setError((err as Error).message || 'Could not save your acceptance. Try again.');
      setBusy(false);
    }
    // On success we're about to unmount — no cleanup needed.
  };

  const title =
    variant === 'first-run' ? 'Welcome to Morion' : 'We updated our Terms';
  const tagline =
    variant === 'first-run'
      ? 'Your local workspace for you and your AI agents.'
      : `Effective ${currentVersion}.`;
  const ctaLabel = variant === 'first-run' ? 'Get started' : 'Accept & continue';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-run-title"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-xl">
        <h1
          id="first-run-title"
          className="mb-2 text-xl font-semibold text-foreground"
        >
          {title}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">{tagline}</p>

        {variant === 're-consent' && changeNote && (
          <p className="mb-6 text-sm text-foreground">
            <span className="font-medium">What changed: </span>
            {changeNote}
          </p>
        )}

        <p className="mb-8 text-sm leading-relaxed text-foreground">
          By continuing, you agree to our{' '}
          <button
            type="button"
            onClick={() => void openExternalUrl('https://morion.ai/terms')}
            className="text-primary underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          >
            Terms of Service
          </button>{' '}
          and{' '}
          <button
            type="button"
            onClick={() => void openExternalUrl('https://morion.ai/privacy')}
            className="text-primary underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
          >
            Privacy Policy
          </button>
          .
        </p>

        <button
          type="button"
          onClick={() => void handleAccept()}
          disabled={busy}
          autoFocus
          className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Saving…' : ctaLabel}
        </button>

        {error && (
          <p
            className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}

        {variant === 'first-run' && (
          <p className="mt-4 text-center text-[11px] text-muted-foreground">
            Local-first. No account. No telemetry.
          </p>
        )}
      </div>
    </div>
  );
}

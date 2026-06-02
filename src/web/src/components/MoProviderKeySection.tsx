import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, ExternalLink } from 'lucide-react';
import { api, type ConciergeProviderStatus } from '../lib/api';
import { cn } from '../lib/cn';
import { openExternalUrl } from '../lib/openExternalUrl';

/**
 * Direction V — "Use my own model" section.
 *
 * Shared by the Ask Mo gear popover AND the per-folder Mo settings
 * dialog. The "built-in" state is today a placeholder — fresh installs
 * have no API key configured so Mo replies "not configured" on every
 * chat. The V8 Cloudflare Worker proxy (tracked as Morion note
 * 01KQ0J9EB701NJ93PC3X7C3Y38) will eventually make the default state
 * work out-of-the-box for Pro subscribers. Until then, users who want
 * Mo today need to supply their own OpenRouter / Groq key.
 *
 * UX contract:
 *   - Toggle OFF (default). Copy reminds the user Mo isn't available
 *     yet in this release without a personal key. No fields shown.
 *   - Toggle ON. Reveals provider select + API key input (password
 *     field with eye toggle) + model override. Minimal signup hint
 *     with a link to the provider's dashboard.
 *
 * Autosave. Every change fires `api.putConciergeProvider(...)` after
 * a 400ms debounce, no Save button. Status refreshes after the PATCH
 * so the "…last4" hint stays accurate.
 */

interface ProviderDefault {
  label: string;
  model: string;
  /** Where to send the user to get credentials. For ollama it's the
   * Ollama install/docs page; for cloud providers it's their API key
   * dashboard. Empty string for "no link". */
  signupUrl: string;
  /** Placeholder hint shown in the credential input. For ollama this
   * describes the base URL format; for cloud providers it describes
   * the key prefix. */
  keyHint: string;
  /** Cosmetic label above the credential field. Cloud = "API key";
   * ollama = "Base URL". */
  keyLabel: string;
  /** Subline shown under the Use-my-own-model toggle. Cloud =
   * "billed by provider"; ollama = "fully local, free". */
  blurb: string;
  /** Whether the credential is a SECRET (cloud key) or not (ollama
   * URL). Drives the password mask + reveal button + "saved last4"
   * hint. */
  isSecret: boolean;
}

// Mirror of server-side defaults in `src/server/concierge-deps.ts`
// (DEFAULT_MODEL_*). The server is the source of truth — when a config
// has no saved model, /api/concierge/provider returns these. We keep
// the labels here client-side because the UI placeholders + signup
// links need them, but the model strings should track the server.
//
// If the server bumps any default, update this map too. Drift is the
// bug Codex finding 01KQ1H63… called out.
const DEFAULTS: Record<ConciergeProviderStatus['backend'], ProviderDefault> = {
  openrouter: {
    label: 'OpenRouter',
    model: 'google/gemini-3.1-flash-lite-preview',
    signupUrl: 'https://openrouter.ai/keys',
    keyHint: 'Starts with sk-or-',
    keyLabel: 'API key',
    blurb:
      "Mo's built-in model isn't available yet in this release. Until then, paste an OpenRouter or Groq API key to use your own — you'll be billed by the provider, not by Morion.",
    isSecret: true,
  },
  groq: {
    label: 'Groq',
    model: 'openai/gpt-oss-120b',
    signupUrl: 'https://console.groq.com/keys',
    keyHint: 'Starts with gsk_',
    keyLabel: 'API key',
    blurb:
      "Mo's built-in model isn't available yet in this release. Until then, paste an OpenRouter or Groq API key to use your own — you'll be billed by the provider, not by Morion.",
    isSecret: true,
  },
  ollama: {
    label: 'Local (Ollama)',
    model: 'qwen2.5:14b-instruct',
    signupUrl: 'https://ollama.com/download',
    // 127.0.0.1, NOT `localhost` — stock Ollama binds IPv4-only and
    // Node fetch can resolve `localhost` to `::1` first → ECONNREFUSED.
    // Mirrors the server-side DEFAULT_OLLAMA_BASE_URL.
    keyHint: 'http://127.0.0.1:11434',
    keyLabel: 'Base URL',
    blurb:
      "Run Mo fully on-device via Ollama — no network calls, no per-token cost. Default port 11434. Recommended models: qwen2.5:14b-instruct (16GB+ RAM) or llama3.1:8b-instruct (8GB+). Avoid reasoning-distill models (deepseek-r1) — they break tool calling.",
    isSecret: false,
  },
  openai: {
    label: 'OpenAI',
    model: 'gpt-5-mini',
    signupUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'Starts with sk-',
    keyLabel: 'API key',
    blurb:
      "Direct OpenAI API key — no OpenRouter markup. Default `gpt-5-mini` ($0.25/$2 per 1M, strong tool calling). Override the model field for `gpt-5` (flagship), `gpt-5-nano` (cheapest), or any reasoning model — they're auto-routed to `max_completion_tokens`.",
    isSecret: true,
  },
  anthropic: {
    label: 'Claude',
    model: 'claude-haiku-4-5-20251001',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'Starts with sk-ant-',
    keyLabel: 'API key',
    blurb:
      "Direct Anthropic API key — no OpenRouter markup. Default `claude-haiku-4-5` ($1/$5 per 1M, fast). Override for `claude-sonnet-4-6` (balanced) or `claude-opus-4-7` (flagship). Mo's translation layer handles the Messages API tool_use / tool_result blocks transparently.",
    isSecret: true,
  },
};

export interface MoProviderKeySectionProps {
  /** Compact variant trims padding for tight popovers (Ask Mo gear).
   * Default is dialog-sized. */
  compact?: boolean;
}

export function MoProviderKeySection({ compact = false }: MoProviderKeySectionProps) {
  const [status, setStatus] = useState<ConciergeProviderStatus | null>(null);
  // Phase 3.5 (epic 01KPGWTJCWVBQCCSQ8NGSB19KQ) — pinned ON.
  // Renamed "Use my own model" → "Use external API". Toggle is
  // disabled because there's no Morion-managed alternative yet
  // (V8 Worker LLM proxy ticket 01KQ0J9EB701NJ93PC3X7C3Y38).
  // Previously the toggle was interactive and flipping it OFF
  // wiped the saved API key from settings — easy to lose your key
  // by accident (user incident 2026-05-14). With it pinned ON, the
  // input + autosave path is always live.
  const useOwn = true;
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [modelDraft, setModelDraft] = useState('');
  const [revealKey, setRevealKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track the previous backend so we can detect a switch and resync
  // both drafts. Pre-fix the drafts only initialised on the first
  // /api/concierge/provider fetch — switching backend updated `status`
  // but left `modelDraft` pointing at the previous backend's model,
  // and the autosave debounce would then save that stale model under
  // the new backend's slot. Codex finding 01KQ1H63C2CAKAGVHM0ZB231TP.
  const prevBackendRef = useRef<ConciergeProviderStatus['backend'] | null>(null);

  // Initial fetch. Presence of an API key → user has already opted in,
  // so flip the toggle on so they don't have to re-click every time
  // the settings surface opens.
  //
  // For NON-SECRET backends (ollama base URL), pre-fill the input with
  // the saved value so the user can see + edit it without retyping.
  // For secret backends, the input stays empty — `apiKeyHint` is
  // `…last4` and showing the actual key in the webview is the leak we
  // explicitly avoid. The autosave-on-mount no-op is gated by the
  // "don't echo what's already stored" check below.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.getConciergeProvider();
        if (!alive) return;
        setStatus(s);
        setModelDraft(s.model ?? '');
        if (!DEFAULTS[s.backend].isSecret) {
          setApiKeyDraft(s.apiKeyHint ?? '');
        }
        prevBackendRef.current = s.backend;
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const backend = status?.backend ?? 'openrouter';
  const defaults = DEFAULTS[backend];

  // Backend-switch resync. When the backend pill click flips
  // `status.backend`, the per-backend saved model + key change too
  // (server tracks them in separate settings keys). Reset the in-flight
  // drafts to the new backend's truth so the user doesn't see (or
  // accidentally save) the previous backend's values.
  //
  // apiKeyDraft → for SECRET backends (groq/openrouter/openai/anthropic):
  //   empty. The saved key sits behind `apiKeyHint = …last4`; the
  //   input is for typing a NEW key, not editing the old one.
  // apiKeyDraft → for NON-SECRET backends (ollama base URL):
  //   pre-fill with the saved URL so the user sees what's stored.
  //   `apiKeyHint` is the full URL for ollama (no secret to mask).
  // modelDraft → status.model (server returned the right value for
  // this backend already).
  useEffect(() => {
    if (!status) return;
    if (prevBackendRef.current === null) return;
    if (prevBackendRef.current === status.backend) return;
    prevBackendRef.current = status.backend;
    setApiKeyDraft(
      DEFAULTS[status.backend].isSecret ? '' : status.apiKeyHint ?? '',
    );
    setModelDraft(status.model ?? '');
  }, [status]);

  /** Autosave helper. Caller passes the next patch; we debounce 400ms
   * so textarea typing doesn't fire a PATCH per keystroke. Clearing the
   * API key field blanks it server-side — send the empty string
   * explicitly.
   *
   * Always carries the current backend if not explicitly set, so a
   * model/key PATCH that races a concurrent backend-switch click can't
   * accidentally save under the wrong backend's slot. */
  const saveProvider = async (patch: {
    backend?: ConciergeProviderStatus['backend'];
    apiKey?: string;
    model?: string;
  }) => {
    setSaving(true);
    setError(null);
    try {
      // Pin backend explicitly. If the caller passed one (the pill
      // click), keep it. Otherwise lock to the backend we KNEW at PATCH
      // time so server reads the right slot even if a different click
      // is in flight.
      const fullPatch =
        patch.backend !== undefined
          ? patch
          : { ...patch, backend: status?.backend };
      const fresh = await api.putConciergeProvider(fullPatch);
      setStatus(fresh);
      // Phase 3.5 — broadcast on backend switch so dependent surfaces
      // (e.g. PipelineModelsSection in SettingsDialog) re-fetch their
      // per-backend setting slots without polling. Same-backend saves
      // (key / model edits) don't fire the event.
      if (patch.backend !== undefined) {
        window.dispatchEvent(
          new CustomEvent('mo-provider-backend-changed', {
            detail: { backend: fresh.backend },
          }),
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // Debounced autosave for the credential field. Behaves differently
  // by `isSecret`:
  //
  //   - SECRET backends: skip empty drafts (don't auto-blank a saved
  //     key on mount; explicit toggle-off is the clear path). Skip
  //     same-as-stored is irrelevant because hint is `…last4`, never
  //     equal to the typed key.
  //   - NON-SECRET backends: skip when draft equals the stored value
  //     (`apiKeyHint` IS the URL for ollama → comparing avoids a
  //     wasted PUT on mount). Empty draft is allowed to save IFF it
  //     differs from stored (i.e. user explicitly cleared the URL
  //     to revert to the default-localhost behavior).
  //
  // The model field's autosave already does the same shape via
  // `modelDraft === status?.model` — we just couldn't apply that to
  // secrets because the hint isn't the value.
  useEffect(() => {
    if (!useOwn) return;
    const stored = status?.apiKeyHint ?? '';
    if (defaults.isSecret) {
      if (apiKeyDraft === '') return; // don't auto-blank on load
    } else {
      if (apiKeyDraft === stored) return; // don't echo unchanged URL
    }
    const t = setTimeout(() => {
      void saveProvider({ apiKey: apiKeyDraft });
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyDraft, useOwn, defaults.isSecret, status?.apiKeyHint]);

  useEffect(() => {
    if (!useOwn) return;
    if (modelDraft === '' || modelDraft === status?.model) return;
    const t = setTimeout(() => {
      void saveProvider({ model: modelDraft });
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelDraft, useOwn]);

  // onToggleUseOwn removed — the toggle is pinned ON and disabled.
  // See `useOwn = true` above. Saved keys can no longer be wiped by
  // an accidental toggle-off.

  const padding = compact ? 'p-0' : 'p-3';

  return (
    <div className={cn('rounded-md', compact ? '' : 'border border-border bg-background/60', padding)}>
      {!compact && (
        <div className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          Model
        </div>
      )}

      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">
            Use external API
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {defaults.blurb}
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground/80">
            Always on for now — every Mo call uses your own provider
            key. A Morion-managed alternative (Pro users skip the key
            step) is on the way; until then this toggle is locked on.
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={true}
          aria-disabled={true}
          aria-label="Use external API (always on; Morion-managed proxy not shipped yet)"
          title="Always on for now — until the Morion-managed LLM proxy ships, every Mo call uses your own API key."
          disabled
          className={cn(
            'relative mt-0.5 inline-flex h-[18px] w-8 shrink-0 cursor-not-allowed items-center rounded-full bg-primary opacity-60 focus-visible:outline-none',
          )}
        >
          <span className="inline-block h-3.5 w-3.5 translate-x-[15px] transform rounded-full bg-background shadow-sm" />
        </button>
      </div>

      {useOwn && (
        <div className="mt-3 space-y-2.5">
          <div role="group" aria-label="Backend provider">
            {/* Static section heading — NOT a `<label htmlFor>` because
                the pill-button group below isn't a single form control
                with an id. The accessible name comes from the parent
                role=group's aria-label. */}
            <div className="block text-[11px] font-medium text-muted-foreground">
              Provider
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {(['openrouter', 'groq', 'openai', 'anthropic', 'ollama'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => void saveProvider({ backend: b })}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    backend === b
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-foreground hover:bg-accent',
                  )}
                >
                  {DEFAULTS[b].label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label
              htmlFor="mo-provider-key"
              className="block text-[11px] font-medium text-muted-foreground"
            >
              {defaults.keyLabel}
              {status?.apiKeyHint && (
                <span className="ml-1.5 font-normal text-muted-foreground/80">
                  · saved: {status.apiKeyHint}
                </span>
              )}
              {!status?.hasApiKey && backend === 'ollama' && (
                <span className="ml-1.5 font-normal text-muted-foreground/80">
                  · default: {defaults.keyHint}
                </span>
              )}
            </label>
            <div className="mt-1 flex gap-1.5">
              <input
                id="mo-provider-key"
                type={defaults.isSecret && !revealKey ? 'password' : 'text'}
                value={apiKeyDraft}
                onChange={(e) => setApiKeyDraft(e.target.value)}
                placeholder={
                  defaults.isSecret && status?.hasApiKey
                    ? '(leave blank to keep saved key)'
                    : defaults.keyHint
                }
                className="flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {defaults.isSecret && (
                <button
                  type="button"
                  onClick={() => setRevealKey((r) => !r)}
                  className="inline-flex h-auto items-center rounded-md border border-border px-2 text-muted-foreground hover:bg-accent"
                  aria-label={revealKey ? 'Hide API key' : 'Reveal API key'}
                  title={revealKey ? 'Hide' : 'Reveal'}
                >
                  {revealKey ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => openExternalUrl(defaults.signupUrl)}
              className="mt-1 inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
            >
              {backend === 'ollama'
                ? 'Install Ollama'
                : `Get a ${defaults.label} key`}
              <ExternalLink className="h-2.5 w-2.5" />
            </button>
          </div>

          {/*
           * Model input is a DEBUG-ONLY surface — kept while the
           * operator smokes-tests different models (2026-04-24).
           * Remove once V8 proxy lands and the UI picks the model
           * server-side. See V8 note 01KQ0J9EB701NJ93PC3X7C3Y38.
           */}
          <div>
            <label
              htmlFor="mo-provider-model"
              className="block text-[11px] font-medium text-muted-foreground"
            >
              Model <span className="ml-1 font-normal italic opacity-70">(debug — removed in a future release)</span>
            </label>
            <input
              id="mo-provider-model"
              type="text"
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              placeholder={defaults.model}
              className="mt-1 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-1 text-[10px] text-muted-foreground">
              Leave blank for default ({defaults.model}).
            </div>
          </div>

          {saving && (
            <div className="text-[10px] text-muted-foreground">Saving…</div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

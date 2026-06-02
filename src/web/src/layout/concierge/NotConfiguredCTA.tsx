import { KeyRound, Settings as SettingsIcon } from 'lucide-react';

/**
 * Rendered in place of the assistant message when Mo's NoopLLMProvider
 * fires (no API key configured). Gives the user a single click to open
 * the gear popover where the "Use my own model" section now lives.
 */
export function NotConfiguredCTA({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-400">
      <div className="mb-1 flex items-center gap-2 font-medium">
        <KeyRound className="h-4 w-4" />
        Mo isn't configured yet
      </div>
      <p className="text-[12px] leading-relaxed text-amber-700/90 dark:text-amber-400/90">
        Mo's built-in model isn't available yet in this release. To use Mo
        today, paste an OpenRouter or Groq API key and Mo will use your own
        model — billed by the provider, not by Morion.
      </p>
      <button
        type="button"
        onClick={onOpenSettings}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-amber-500/20 px-3 py-1.5 text-[12px] font-medium text-amber-800 hover:bg-amber-500/30 dark:text-amber-300"
      >
        <SettingsIcon className="h-3.5 w-3.5" />
        Open Mo settings
      </button>
    </div>
  );
}

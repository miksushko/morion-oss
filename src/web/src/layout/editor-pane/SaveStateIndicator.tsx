import { AlertCircle, Check as CheckIcon, Loader2 } from 'lucide-react';
import type { SaveState } from '../../appShellTypes';

/**
 * Tiny status pill that lives next to the "Edited X" button in the editor
 * footer. Mirrors the autosave indicator pattern Notion / Linear / Asana
 * use — invisible when nothing is happening, briefly visible when a save
 * is inflight or just completed, and sticky on failure so the user knows
 * something is wrong even if they missed the toast.
 */
export function SaveStateIndicator({ state }: { state: SaveState }) {
  if (state === 'idle') return null;
  if (state === 'saving') {
    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-1.5 text-muted-foreground"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Saving…</span>
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-1.5 text-emerald-500/80"
      >
        <CheckIcon className="h-3 w-3" />
        <span>Saved</span>
      </span>
    );
  }
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-1.5 text-destructive"
    >
      <AlertCircle className="h-3 w-3" />
      <span>Save failed</span>
    </span>
  );
}

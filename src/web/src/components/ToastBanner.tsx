import { Check, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/cn';
import type { ToastState } from '../hooks/useToast';

/**
 * One-shot status toast. Rendered at the top-center of the viewport,
 * pointer-events: none so it never blocks clicks underneath. Auto-
 * dismisses via `useToast`'s timer; the banner itself is purely a
 * presentational view.
 *
 * Two variants: `success` (green check — "Copied", etc.) and `error`
 * (amber alert — e.g. a kanban drag that couldn't start auto-code).
 */
export function ToastBanner({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;
  const isError = toast.variant === 'error';
  return (
    <div
      role="status"
      aria-live={isError ? 'assertive' : 'polite'}
      className={cn(
        'pointer-events-none fixed left-1/2 top-3 z-50 flex max-w-[min(92vw,32rem)] -translate-x-1/2 items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium shadow-lg backdrop-blur',
        isError
          ? 'border-destructive/50 bg-destructive/10 text-destructive'
          : 'border-ring/60 bg-card/95 text-foreground',
      )}
    >
      {isError ? (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
      )}
      <span className="min-w-0">{toast.message}</span>
    </div>
  );
}

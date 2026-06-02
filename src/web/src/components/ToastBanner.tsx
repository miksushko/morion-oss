import { Check } from 'lucide-react';

/**
 * One-shot status toast. Rendered at the top-center of the viewport,
 * pointer-events: none so it never blocks clicks underneath. Auto-
 * dismisses via `useToast`'s timer; the banner itself is purely a
 * presentational view.
 */
export function ToastBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-ring/60 bg-card/95 px-3.5 py-1.5 text-xs font-medium text-foreground shadow-lg backdrop-blur"
    >
      <Check className="h-3.5 w-3.5 text-emerald-400" />
      {message}
    </div>
  );
}

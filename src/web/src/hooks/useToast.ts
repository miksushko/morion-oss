import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Global "Copied to clipboard" / one-shot status toast. Lives at App
 * level so every Share / Copy entry point — editor header buttons,
 * NotesList header share button, note row right-click, folder row
 * right-click, folder three-dot menu — gets the same feedback without
 * each component rolling its own.
 *
 * The toast auto-dismisses after `durationMs` (default 1.8s). Calling
 * `showToast` again resets the timer; the unmount cleanup clears any
 * pending timer so a fast-closing dialog doesn't leak.
 */
export type ToastVariant = 'success' | 'error';
export interface ToastState {
  message: string;
  variant: ToastVariant;
}

export function useToast(durationMs = 1800) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Back-compat: `showToast('done')` keeps the old success flash. Pass
  // `{ variant: 'error', durationMs }` for a longer, red error banner —
  // used e.g. when a kanban drag couldn't start auto-code.
  const showToast = useCallback(
    (
      message: string,
      opts?: { variant?: ToastVariant; durationMs?: number },
    ) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setToast({ message, variant: opts?.variant ?? 'success' });
      timerRef.current = setTimeout(
        () => setToast(null),
        opts?.durationMs ?? durationMs,
      );
    },
    [durationMs],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { toast, showToast };
}

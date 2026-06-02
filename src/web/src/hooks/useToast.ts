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
export function useToast(durationMs = 1800) {
  const [toast, setToast] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback(
    (message: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setToast(message);
      timerRef.current = setTimeout(() => setToast(null), durationMs);
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

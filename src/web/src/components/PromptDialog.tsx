import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * In-app replacement for `window.prompt()`. Mirrors `ConfirmDialog`'s
 * Provider / Promise-hook pattern — call sites do
 *   const next = await prompt({ title: 'Rename folder', initial: f.name });
 *   if (next != null) doRename(next);
 *
 * Resolves to:
 *   - the trimmed string the user typed when they hit Save / Enter
 *   - `null` when they hit Cancel / Escape / backdrop-click
 *   - `null` when the trimmed string equals `initial` (no-op rename)
 *
 * Why a Morion-styled modal instead of `window.prompt`:
 * `window.prompt` renders the browser's chrome dialog (different look on
 * Chrome / Safari / Tauri WebKit), can't be themed, breaks the focus
 * model on Tauri (steals focus from the app frame), and was making the
 * folder-rename + chat-rename UX feel out-of-band. Single in-app
 * component replaces both. Ticket bullet: "rename надо сделать в своем
 * morion попапе. Тоже самое для переименования чатов".
 *
 * Single live request at a time — same shape as ConfirmDialog. Stacking
 * prompts is a footgun and we don't need it.
 */

export interface PromptOptions {
  title: string;
  /** Inline label rendered above the input. Optional. */
  label?: ReactNode;
  /** Placeholder shown when the input is empty. Optional. */
  placeholder?: string;
  /** Initial input value. Defaults to ''. */
  initial?: string;
  /** Defaults to "Save". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Optional secondary description shown above the input. */
  description?: ReactNode;
  /** Validation predicate. Returns an error string to keep the dialog
   *  open + show the message; returns null to allow submit. Default:
   *  trim non-empty + non-equal-to-initial. */
  validate?: (value: string, initial: string) => string | null;
}

type PromptFn = (opts: PromptOptions) => Promise<string | null>;

const PromptContext = createContext<PromptFn | null>(null);

interface PendingPrompt extends PromptOptions {
  resolve: (value: string | null) => void;
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingPrompt | null>(null);
  const pendingRef = useRef<PendingPrompt | null>(null);
  pendingRef.current = pending;

  const prompt = useCallback<PromptFn>((opts) => {
    return new Promise<string | null>((resolve) => {
      const previous = pendingRef.current;
      if (previous) previous.resolve(null);
      setPending({ ...opts, resolve });
    });
  }, []);

  const settle = useCallback((value: string | null) => {
    setPending((cur) => {
      if (cur) cur.resolve(value);
      return null;
    });
  }, []);

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      {pending && <PromptDialog options={pending} onSettle={settle} />}
    </PromptContext.Provider>
  );
}

export function usePrompt(): PromptFn {
  const ctx = useContext(PromptContext);
  if (!ctx) throw new Error('usePrompt must be used inside PromptProvider');
  return ctx;
}

interface DialogProps {
  options: PromptOptions;
  onSettle: (value: string | null) => void;
}

function defaultValidate(value: string, initial: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Cannot be empty.';
  if (trimmed === initial.trim()) return null; // we'll resolve null below
  return null;
}

function PromptDialog({ options, onSettle }: DialogProps) {
  const initial = options.initial ?? '';
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const validate = options.validate ?? defaultValidate;

  const cancel = useCallback(() => {
    onSettle(null);
  }, [onSettle]);

  const submit = useCallback(() => {
    const err = validate(value, initial);
    if (err) {
      setError(err);
      return;
    }
    const trimmed = value.trim();
    // No-op rename — return null so the caller's `if (next != null)`
    // guard skips the action. Distinguishes "user explicitly accepted
    // the unchanged value" from "user submitted a real change".
    if (trimmed === initial.trim()) {
      onSettle(null);
      return;
    }
    onSettle(trimmed);
  }, [value, initial, validate, onSettle]);

  useEffect(() => {
    // Autofocus + select-all so the user can either replace the value
    // immediately or arrow-key into it.
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter') {
        if (dialogRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          submit();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cancel, submit]);

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 px-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-dialog-title"
        className="w-full max-w-sm overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-2xl"
      >
        <div className="px-5 pt-5">
          <h2
            id="prompt-dialog-title"
            className="text-base font-semibold text-foreground"
          >
            {options.title}
          </h2>
          {options.description && (
            <div className="mt-2 whitespace-pre-line text-sm text-muted-foreground">
              {options.description}
            </div>
          )}
          {options.label && (
            <label
              htmlFor="prompt-dialog-input"
              className="mt-4 block text-xs font-medium text-muted-foreground"
            >
              {options.label}
            </label>
          )}
          <input
            ref={inputRef}
            id="prompt-dialog-input"
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            placeholder={options.placeholder}
            className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {error && (
            <div className="mt-2 text-xs text-destructive">{error}</div>
          )}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
          <button
            type="button"
            onClick={cancel}
            className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
          >
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            onClick={submit}
            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
          >
            {options.confirmLabel ?? 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

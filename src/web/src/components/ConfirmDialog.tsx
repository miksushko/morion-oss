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
import { cn } from '../lib/cn';

/**
 * In-app replacement for `window.confirm()`. One global modal lives at the
 * root of the tree (`ConfirmProvider`); call sites use `useConfirm()` to get
 * a Promise-based `confirm({ ... })` function that resolves to `true` when
 * the user accepts and `false` on cancel / Escape / backdrop click.
 *
 * Why a Promise API: keeps the call-site shape identical to `window.confirm`
 * (`if (await confirm(...)) doIt()`), so we can swap every existing
 * destructive action over without restructuring its handler into pre-open /
 * on-confirm callbacks. The Provider keeps a single live request at a time —
 * stacking modals is a footgun and we never need it for a notebook.
 *
 * Styling matches the rest of the app: themed via the same HSL tokens used
 * by every other surface, focus ring + active scale on the buttons, an
 * optional `destructive` flag swaps the confirm button to the destructive
 * palette so "Delete forever" reads red.
 */

export interface ConfirmCheckboxOption {
  /** Label shown next to the checkbox in the dialog body. */
  label: ReactNode;
  /** Whether the checkbox is pre-checked when the dialog opens. Defaults to false. */
  defaultChecked?: boolean;
}

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  /** Defaults to "Confirm". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /** Switches the confirm button to the destructive palette. */
  destructive?: boolean;
  /** Optional checkbox rendered between description and footer. When set,
   *  the resolved promise carries the checkbox state alongside `confirmed`
   *  (use the overloaded call signature on `useConfirm`). Used by destructive
   *  flows that need a "and also delete X" toggle (folder delete + notes,
   *  ticket `01KQFDZB7C61F5EMKQEKYPP3YA`). */
  checkbox?: ConfirmCheckboxOption;
}

export interface ConfirmResult {
  confirmed: boolean;
  checkboxChecked: boolean;
}

/**
 * Overloaded so the most common boolean call site stays a one-liner
 * (`if (await confirm(...))`) while the rare checkbox flow gets a
 * structured result without runtime type guesswork.
 */
type ConfirmFn = {
  (opts: ConfirmOptions & { checkbox: ConfirmCheckboxOption }): Promise<ConfirmResult>;
  (opts: ConfirmOptions): Promise<boolean>;
};

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface PendingConfirm extends ConfirmOptions {
  /** Resolver that decides shape based on whether `checkbox` was set on
   *  the original opts. The overloaded `ConfirmFn` type guarantees the
   *  caller awaits the right shape. */
  resolve: (value: ConfirmResult) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Single live request at a time — if a second confirm is requested while
  // the first is open, we settle the first as `false` and replace it. Edge
  // case (we never trigger this in practice) but cheaper than crashing.
  const pendingRef = useRef<PendingConfirm | null>(null);
  pendingRef.current = pending;

  const confirm = useCallback(((opts: ConfirmOptions) => {
    return new Promise<boolean | ConfirmResult>((resolve) => {
      const previous = pendingRef.current;
      if (previous)
        previous.resolve({ confirmed: false, checkboxChecked: false });
      setPending({
        ...opts,
        resolve: (result: ConfirmResult) => {
          // Boolean call site — return just `confirmed` so existing
          // `if (await confirm(...))` keeps working.
          if (opts.checkbox) resolve(result);
          else resolve(result.confirmed);
        },
      });
    });
  }) as ConfirmFn, []);

  const settle = useCallback((result: ConfirmResult) => {
    setPending((cur) => {
      if (cur) cur.resolve(result);
      return null;
    });
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          options={pending}
          onSettle={settle}
        />
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside ConfirmProvider');
  return ctx;
}

interface DialogProps {
  options: ConfirmOptions;
  onSettle: (result: ConfirmResult) => void;
}

function ConfirmDialog({ options, onSettle }: DialogProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [checkboxChecked, setCheckboxChecked] = useState(
    options.checkbox?.defaultChecked ?? false,
  );
  // Stash the latest checkbox state in a ref so the onConfirm/onCancel
  // closures (set up once) always read the freshest value.
  const checkboxRef = useRef(checkboxChecked);
  checkboxRef.current = checkboxChecked;

  const confirm = useCallback(() => {
    onSettle({ confirmed: true, checkboxChecked: checkboxRef.current });
  }, [onSettle]);
  const cancel = useCallback(() => {
    onSettle({ confirmed: false, checkboxChecked: checkboxRef.current });
  }, [onSettle]);

  useEffect(() => {
    // Autofocus the confirm button so Enter accepts and Tab cycles inside.
    confirmBtnRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter') {
        // Only swallow when the focus is inside the dialog — otherwise we
        // could hijack a stray Enter from elsewhere on the page.
        if (dialogRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          confirm();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cancel, confirm]);

  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/70 px-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Backdrop click cancels — but only if the click started on the
        // backdrop itself, not bubbling up from the dialog content.
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={options.description ? 'confirm-dialog-description' : undefined}
        className="w-full max-w-sm overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-2xl"
      >
        <div className="px-5 pt-5">
          <h2
            id="confirm-dialog-title"
            className="text-base font-semibold text-foreground"
          >
            {options.title}
          </h2>
          {options.description && (
            <div
              id="confirm-dialog-description"
              className="mt-2 whitespace-pre-line text-sm text-muted-foreground"
            >
              {options.description}
            </div>
          )}
          {options.checkbox && (
            <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={checkboxChecked}
                onChange={(e) => setCheckboxChecked(e.target.checked)}
                className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border text-primary focus:ring-2 focus:ring-ring"
              />
              <span className="select-none">{options.checkbox.label}</span>
            </label>
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
            ref={confirmBtnRef}
            type="button"
            onClick={confirm}
            className={cn(
              'inline-flex h-8 items-center rounded-md px-3 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]',
              options.destructive
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {options.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

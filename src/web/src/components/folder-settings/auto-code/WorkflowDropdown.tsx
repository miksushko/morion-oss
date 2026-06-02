import { useEffect, useRef, useState } from 'react';
import { type AutoCodeWorkflowSummary } from '../../../lib/api';
import { cn } from '../../../lib/cn';

/** Custom in-app dropdown for the active-workflow picker. Replaces
 *  the native `<select>` so menu chrome matches the design system in
 *  every webview (native `<option>` rendering looks foreign on macOS
 *  + breaks against the dark theme). Trigger + popover styled like
 *  the rest of the popup's controls; click outside / Esc closes. */
export function WorkflowDropdown({
  workflows,
  activeId,
  disabled,
  onPick,
}: {
  workflows: AutoCodeWorkflowSummary[];
  activeId: string;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = workflows.find((w) => w.id === activeId);
  const triggerLabel = workflows.length === 0
    ? 'Loading…'
    : active?.name ?? 'Pick a workflow';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || workflows.length === 0}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-[12px] text-foreground outline-none transition-colors',
          'hover:bg-accent/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background',
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="truncate">{triggerLabel}</span>
          {active?.isDefault && (
            <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary">
              default
            </span>
          )}
        </span>
        <svg
          className="shrink-0 text-muted-foreground"
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          {workflows.map((w) => {
            const isSelected = w.id === activeId;
            return (
              <li key={w.id} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(w.id);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[12px] transition-colors',
                    isSelected
                      ? 'bg-accent text-foreground'
                      : 'text-foreground hover:bg-accent/60',
                  )}
                >
                  <span className="flex-1 truncate">{w.name}</span>
                  {w.isDefault && (
                    <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary">
                      default
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

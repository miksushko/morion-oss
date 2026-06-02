import { cn } from '../lib/cn';

/**
 * Shared label-on-left, switch-on-right row used across folder/note
 * settings dialogs. Lives in its own file so both
 * `FolderSettingsDialog` and `MCPPermissionsDialog` can render the
 * same visual without circular imports.
 *
 * Visual contract:
 *   - Label aligned with the top of the switch (`mt-0.5` on switch).
 *   - Optional `hint` line in muted-foreground beneath the label.
 *   - Switch is `role="switch"` (NOT a checkbox) so the screen-reader
 *     story matches the visual.
 *   - `indent` adds an indented border-left rail — used for sub-rows
 *     (e.g. "Allow creating notes" under "Visible to AI").
 */
export interface SwitchRowProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Render with an indented left rail to express hierarchy (sub-row). */
  indent?: boolean;
}

export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
  indent = false,
}: SwitchRowProps) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 py-1',
        indent && 'border-l border-border pl-4',
      )}
    >
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'text-sm font-medium',
            disabled ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {label}
        </div>
        {hint && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {hint}
          </div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled}
        aria-label={label}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
        className={cn(
          'relative mt-0.5 inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          checked ? 'bg-primary' : 'bg-muted',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span
          className={cn(
            'inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform',
            checked ? 'translate-x-[15px]' : 'translate-x-[1px]',
          )}
        />
      </button>
    </div>
  );
}

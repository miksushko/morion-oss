import { cn } from '../../lib/cn';

/** Single row inside a `NoteActionsMenu` popover. Shared by the
 *  three-dot more-menu and the "Move to..." folder picker. */
export function NoteMenuItem({
  icon,
  label,
  onClick,
  disabled,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'flex w-full items-center gap-2 truncate px-3 py-1.5 text-left transition-colors',
        disabled && 'cursor-not-allowed opacity-40',
        !disabled && (destructive ? 'hover:bg-destructive/10 hover:text-destructive' : 'hover:bg-accent'),
      )}
      title={label}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

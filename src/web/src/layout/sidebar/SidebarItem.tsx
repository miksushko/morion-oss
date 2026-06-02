import { cn } from '../../lib/cn';

/** Generic nav row used by All notes, Tags, Trash. Drop-target wiring is
 *  optional — only All notes (the "unfile" target) passes it. */
export function SidebarItem({
  icon,
  label,
  count,
  active,
  isDropTarget,
  onClick,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active: boolean;
  isDropTarget?: boolean;
  onClick: () => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-3 py-1 text-left text-foreground transition-colors',
        active ? 'bg-accent' : 'hover:bg-accent/60',
        isDropTarget && 'ring-1 ring-ring',
      )}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
      )}
    </button>
  );
}

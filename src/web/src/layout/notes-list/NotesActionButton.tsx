/**
 * Row-styled action button for the NotesList header. Mirrors the Mo
 * Chat sidebar's `SidebarActionButton` primitive so the two panels
 * read as sibling surfaces (ticket `01KQXZJX3KSY32B7J9HZNGZ9T2`).
 */
export function NotesActionButton({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="inline-flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && (
        <kbd className="shrink-0 rounded border border-border px-1 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {shortcut}
        </kbd>
      )}
    </button>
  );
}

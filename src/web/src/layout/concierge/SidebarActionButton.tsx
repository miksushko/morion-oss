import type { ReactNode } from 'react';

/**
 * Single full-width row in the Mo Chat sidebar (New chat / Search /
 * Mo Settings). Mo Chat ticket `01KQXX6P005Y4YQZ5MPAD8ZBD0` follow-up:
 * height + horizontal anchor MUST match `ChatList` row so the sidebar
 * reads as a single visual column. h-8 mirrors the chat row; the `w-4`
 * slot is the same width the chat row uses for the 6x6 indicator dot,
 * so the icon center lines up with the dot center on every row.
 */
export function SidebarActionButton({
  icon,
  label,
  onClick,
  ariaExpanded,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  ariaExpanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={ariaExpanded}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-foreground hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="inline-flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

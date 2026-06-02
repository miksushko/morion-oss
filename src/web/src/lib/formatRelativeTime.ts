/**
 * Compact relative-time formatter — "just now / 12m ago / 3h ago /
 * Yesterday / 4d ago / Mar 5". Mirrors the grammar used in NotesList +
 * RevisionsPopover so every timestamp surface reads the same way.
 */
export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return 'Yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Compact variant for list rows (sidebar chats, Codex-style). No "ago"
 * suffix, no "Yesterday" — just a tight `1m / 6h / 3d / 2w / Mar 5`.
 */
export function formatRelativeTimeCompact(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  if (diff < minute) return 'now';
  if (diff < hour) return `${Math.floor(diff / minute)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  if (diff < week) return `${Math.floor(diff / day)}d`;
  if (diff < 30 * day) return `${Math.floor(diff / week)}w`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

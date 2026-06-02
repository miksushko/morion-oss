import { cn } from '../lib/cn';

/**
 * Compact row of single-letter permission glyphs, shown next to folder
 * names / note titles when the user has toggled on "Review MCP access"
 * in the gear menu. Each glyph = one MCP action:
 *
 *   V — Visible to AI (read)
 *   C — Create new notes (folder only)
 *   E — Edit / update
 *   D — Delete
 *
 * Green-ish accent color = allowed, muted grey = denied. Tooltip on
 * each glyph spells out the full label so keyboard / screen-reader
 * users don't have to decode the letters.
 *
 * Attached inline to the row so it lives within the row's baseline
 * (no vertical growth) — keeps list density intact even when review
 * mode is on.
 */

export interface PermGlyph {
  letter: 'V' | 'C' | 'E' | 'D';
  label: string;
  allowed: boolean;
  /** Optional: marks a note's own override vs folder inheritance. Drawn
   * as a tiny ring around the glyph so the user sees at a glance which
   * cells are pinned locally. Ignored for folders. */
  pinned?: boolean;
}

interface Props {
  entries: PermGlyph[];
  className?: string;
}

export function McpPermsStrip({ entries, className }: Props) {
  return (
    <span
      role="group"
      aria-label="MCP permissions"
      className={cn('inline-flex shrink-0 items-center gap-0.5', className)}
    >
      {entries.map((e) => (
        <span
          key={e.letter}
          title={`${e.label}: ${e.allowed ? 'allowed' : 'denied'}${e.pinned ? ' (custom override)' : ''}`}
          className={cn(
            'inline-flex h-4 w-4 items-center justify-center rounded-sm text-[9px] font-semibold leading-none',
            e.allowed
              ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300'
              : 'bg-muted text-muted-foreground/60',
            e.pinned && 'ring-1 ring-primary/60 ring-offset-[1px] ring-offset-background',
          )}
        >
          {e.letter}
        </span>
      ))}
    </span>
  );
}

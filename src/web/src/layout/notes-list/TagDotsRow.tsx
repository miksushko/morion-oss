import { useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';

/** How many color dots we show inline before collapsing the rest into a `+N`. */
export const MAX_TAG_DOTS = 4;

/**
 * Small colored-dot row under each note's metadata. Shows up to
 * `MAX_TAG_DOTS` dots (one per tag, in the order the note stores them),
 * then `+N` text for the rest. Deliberately no names inline — those
 * live in the Tag manager.
 *
 * On hover we render a floating tooltip via a portal so it can escape
 * the notes-list `overflow-y-auto` clip. The tooltip lists every tag
 * with its colored dot + name. `position: fixed` is computed against
 * the row's bounding rect at hover time.
 */
export function TagDotsRow({
  tags,
  colorByName,
}: {
  tags: string[];
  colorByName: Map<string, string | null>;
}) {
  const [hoverPos, setHoverPos] = useState<
    { x: number; y: number; placeBelow: boolean } | null
  >(null);
  const visible = tags.slice(0, MAX_TAG_DOTS);
  const extra = tags.length - visible.length;

  const handleEnter = (e: React.MouseEvent<HTMLSpanElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // If there isn't enough room above (top half of viewport), drop the
    // tooltip below the row instead.
    const placeBelow = rect.top < 120;
    setHoverPos({
      x: rect.left + rect.width / 2,
      y: placeBelow ? rect.bottom + 6 : rect.top - 6,
      placeBelow,
    });
  };
  const handleLeave = () => setHoverPos(null);

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      aria-label={`tags: ${tags.join(', ')}`}
    >
      {visible.map((name) => {
        const color = colorByName.get(name);
        return (
          <span
            key={name}
            className={cn(
              'h-2 w-2 rounded-full',
              color ? '' : 'border border-muted-foreground/40',
            )}
            style={color ? { backgroundColor: color } : undefined}
          />
        );
      })}
      {extra > 0 && (
        <span className="text-[9px] normal-case tracking-normal text-muted-foreground">
          +{extra}
        </span>
      )}
      {hoverPos &&
        createPortal(
          <div
            className={cn(
              'pointer-events-none fixed z-50 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              hoverPos.placeBelow ? '' : '-translate-y-full',
            )}
            style={{ left: hoverPos.x, top: hoverPos.y }}
            role="tooltip"
          >
            <ul className="flex flex-col gap-1 normal-case tracking-normal">
              {tags.map((name) => {
                const color = colorByName.get(name);
                return (
                  <li key={name} className="flex items-center gap-1.5">
                    <span
                      className={cn(
                        'h-2 w-2 shrink-0 rounded-full',
                        color ? '' : 'border border-muted-foreground/40',
                      )}
                      style={color ? { backgroundColor: color } : undefined}
                    />
                    <span className="text-foreground">{name}</span>
                  </li>
                );
              })}
            </ul>
          </div>,
          document.body,
        )}
    </span>
  );
}

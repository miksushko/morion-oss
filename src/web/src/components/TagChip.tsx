import { X } from 'lucide-react';
import type { Tag } from '../lib/api';
import { DEFAULT_TAG_BG, pickTextColor } from '../lib/tagColors';
import { cn } from '../lib/cn';

interface Props {
  /** Either a full Tag (with color from the catalogue) or just a name string. */
  tag: Pick<Tag, 'name' | 'color'>;
  size?: 'sm' | 'md' | 'lg';
  onRemove?: () => void;
  onClick?: () => void;
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<Props['size']>, string> = {
  sm: 'h-5 px-2 text-[11px]',
  md: 'h-6 px-2.5 text-xs',
  lg: 'h-8 px-3 text-sm',
};

/**
 * A colored tag chip with auto-chosen text color (WCAG AA-safe). When the
 * tag has no explicit color we fall back to a neutral slate so a brand-new
 * unstyled tag still looks like a chip, not a label.
 */
export function TagChip({ tag, size = 'md', onRemove, onClick, className }: Props) {
  const bg = tag.color ?? DEFAULT_TAG_BG;
  const { color: fg } = pickTextColor(bg);
  const interactive = Boolean(onClick);

  return (
    <span
      onClick={onClick}
      title={tag.name}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      style={{ backgroundColor: bg, color: fg }}
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1 rounded-full font-medium leading-none',
        SIZE_CLASSES[size],
        interactive && 'cursor-pointer transition-opacity hover:opacity-90',
        className,
      )}
    >
      <span className="min-w-0 truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${tag.name}`}
          className="-mr-1 inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-black/10"
          style={{ color: fg }}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

import { useState } from 'react';
import { Check } from 'lucide-react';
import { TAG_PALETTE, isValidHex, normalizeHex, pickTextColor } from '../lib/tagColors';
import { cn } from '../lib/cn';

interface Props {
  value: string | null;
  onChange: (next: string | null) => void;
  /** When true, render a "No color" swatch that maps to null. */
  allowNone?: boolean;
}

/**
 * Two-row palette of WCAG-safe swatches plus a custom hex input. The hex
 * input lights up red and warns when the entered color can't reach AA
 * contrast against either near-black or near-white text — the user can
 * still apply it, but they're informed.
 */
export function ColorPicker({ value, onChange, allowNone = true }: Props) {
  const [hex, setHex] = useState(value ?? '');
  const normalized = isValidHex(hex) ? normalizeHex(hex) : null;
  const customWarning = normalized ? !pickTextColor(normalized).meetsAA : false;

  const half = TAG_PALETTE.length / 2;
  const deepRow = TAG_PALETTE.slice(0, half);
  const softRow = TAG_PALETTE.slice(half);

  const isSelected = (swatchHex: string): boolean => {
    if (!value) return false;
    return normalizeHex(value) === normalizeHex(swatchHex);
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-9 gap-1.5">
        {deepRow.map((s) => (
          <Swatch
            key={s.hex}
            hex={s.hex}
            label={s.name}
            selected={isSelected(s.hex)}
            onClick={() => onChange(s.hex)}
          />
        ))}
        {softRow.map((s) => (
          <Swatch
            key={s.hex}
            hex={s.hex}
            label={s.name}
            selected={isSelected(s.hex)}
            onClick={() => onChange(s.hex)}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 pt-1">
        {allowNone && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className={cn(
              'rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent',
              value === null && 'border-ring text-foreground',
            )}
          >
            No color
          </button>
        )}
        <div className="flex flex-1 items-center gap-2">
          <input
            type="text"
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            placeholder="#hex"
            className={cn(
              'h-7 w-24 rounded-md border bg-background px-2 font-mono text-[11px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring',
              normalized || hex === '' ? 'border-border' : 'border-destructive',
            )}
          />
          <button
            type="button"
            disabled={!normalized}
            onClick={() => {
              if (normalized) onChange(normalized);
            }}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            Apply
          </button>
          {customWarning && (
            <span className="text-[10px] text-destructive">low contrast</span>
          )}
        </div>
      </div>
    </div>
  );
}

function Swatch({
  hex,
  label,
  selected,
  onClick,
}: {
  hex: string;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  const { color: fg } = pickTextColor(hex);
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      style={{ backgroundColor: hex }}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded-md border transition-transform hover:scale-110',
        selected ? 'border-foreground ring-1 ring-foreground' : 'border-black/10',
      )}
    >
      {selected && <Check className="h-3 w-3" style={{ color: fg }} />}
    </button>
  );
}

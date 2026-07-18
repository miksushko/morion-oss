import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Tag as TagIcon } from 'lucide-react';
import type { Tag } from '../lib/api';
import { TagChip } from './TagChip';
import { ColorPicker } from './ColorPicker';
import { cn } from '../lib/cn';

interface Props {
  /** Full tag catalogue (with colors). */
  allTags: Tag[];
  /** Tag names already attached to the current note. */
  selected: string[];
  /** Toggle a tag on the current note by name. */
  onToggle: (tagName: string) => void;
  /**
   * Create a brand new tag in the catalogue with an optional color and
   * immediately attach it to the current note. Returns the created Tag so
   * callers can update local state.
   */
  onCreateTag: (name: string, color: string | null) => Promise<Tag>;
  onClose: () => void;
}

/**
 * Popover that shows under the "+ Add tag" button. Lists all catalogue
 * tags filtered by a typed query, lets the user toggle them on/off the
 * current note, and offers a "Create new tag" affordance with the same
 * WCAG-safe color picker the Tag manager uses.
 *
 * Closes on outside click or Escape.
 */
export function TagPicker({ allTags, selected, onToggle, onCreateTag, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? allTags.filter((t) => t.name.toLowerCase().includes(q)) : allTags;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [allTags, query]);

  const exactMatch = filtered.find((t) => t.name.toLowerCase() === query.trim().toLowerCase());
  const canQuickCreate = query.trim().length > 0 && !exactMatch;

  const handleQuickCreate = async () => {
    const name = query.trim();
    if (!name) return;
    setBusy(true);
    try {
      await onCreateTag(name, null);
      setQuery('');
    } finally {
      setBusy(false);
    }
  };

  const handleDetailedCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await onCreateTag(name, newColor);
      setNewName('');
      setNewColor(null);
      setCreating(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-popover p-2 shadow-lg"
      style={{ background: 'hsl(var(--card))' }}
    >
      <div className="px-1 pb-2">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canQuickCreate) {
              e.preventDefault();
              handleQuickCreate();
            }
          }}
          placeholder="Search or create tag…"
          // A tag name isn't prose — kill the native
          // autocomplete/autofill dropdown + the macOS/WebKit autocorrect
          // suggestion bubble ("Bug | ×") that otherwise overlaps the tag
          // list and steals clicks.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="max-h-56 overflow-y-auto">
        {filtered.length === 0 && !canQuickCreate && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            No tags yet. Type a name to create one.
          </div>
        )}
        {filtered.map((t) => {
          const active = selected.includes(t.name);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onToggle(t.name)}
              className={cn(
                'flex w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60',
                active && 'bg-accent',
              )}
            >
              <span className="min-w-0 flex-1">
                <TagChip tag={t} size="sm" />
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {active ? 'remove' : 'add'}
              </span>
            </button>
          );
        })}
        {canQuickCreate && (
          <button
            type="button"
            disabled={busy}
            onClick={handleQuickCreate}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent/60 disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            Create &ldquo;{query.trim()}&rdquo;
          </button>
        )}
      </div>

      <div className="mt-2 border-t border-border pt-2">
        {creating ? (
          <div className="space-y-2 px-1">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Tag name"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              autoFocus
            />
            <ColorPicker value={newColor} onChange={setNewColor} />
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setNewName('');
                  setNewColor(null);
                }}
                className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !newName.trim()}
                onClick={handleDetailedCreate}
                className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Create tag
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setCreating(true);
              setNewName(query.trim());
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <TagIcon className="h-3 w-3" />
            New tag with color…
          </button>
        )}
      </div>
    </div>
  );
}

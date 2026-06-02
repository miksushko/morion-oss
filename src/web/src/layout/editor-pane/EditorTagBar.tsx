import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';
import type { Tag } from '../../lib/api';
import { TagChip } from '../../components/TagChip';
import { TagPicker } from '../../components/TagPicker';
import { cn } from '../../lib/cn';

/**
 * Inline tag chips with overflow dots + popover. Shows up to
 * `MAX_INLINE` full chips, then colored dots + "+N" that opens a
 * popover with all tags as full chips (with remove). Always one line.
 */
export function EditorTagBar({
  tags,
  tagsByName,
  trashMode,
  onRemoveTag,
  pickerOpen,
  onTogglePicker,
  onClosePicker,
  allTags,
  onToggleTag,
  onCreateTag,
}: {
  tags: string[];
  tagsByName: Map<string, Tag>;
  trashMode: boolean;
  onRemoveTag: (name: string) => void;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onClosePicker: () => void;
  allTags: Tag[];
  onToggleTag: (name: string) => void;
  onCreateTag: (name: string, color: string) => Promise<Tag>;
}) {
  const [dotsOpen, setDotsOpen] = useState(false);
  const dotsRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close dots popover on outside click / Escape
  useEffect(() => {
    if (!dotsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDotsOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        dotsRef.current &&
        !dotsRef.current.contains(e.target as Node)
      ) {
        setDotsOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [dotsOpen]);

  const resolveTag = (name: string) =>
    tagsByName.get(name) ?? { name, color: null, id: name, noteCount: 0 };

  const MAX_INLINE = 2;
  const inlineTags = tags.slice(0, MAX_INLINE);
  const overflowTags = tags.slice(MAX_INLINE);

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {/* First N tags as full chips */}
      {inlineTags.map((name) => (
        <TagChip
          key={name}
          tag={resolveTag(name)}
          size="sm"
          onRemove={trashMode ? undefined : () => onRemoveTag(name)}
        />
      ))}

      {/* Overflow: colored dots + "+N" opens a popover with ALL tags */}
      {overflowTags.length > 0 && (
        <div className="relative flex shrink-0 items-center">
          <button
            ref={dotsRef}
            type="button"
            onClick={() => setDotsOpen((v) => !v)}
            className="inline-flex h-5 items-center gap-0.5 rounded-full bg-muted/60 px-1.5 text-[9px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={`${overflowTags.length} more tags`}
          >
            {overflowTags.map((name) => {
              const color = resolveTag(name).color;
              return (
                <span
                  key={name}
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    color ? '' : 'border border-muted-foreground/40',
                  )}
                  style={color ? { backgroundColor: color } : undefined}
                />
              );
            })}
            <span className="ml-0.5">+{overflowTags.length}</span>
          </button>

          {dotsOpen &&
            createPortal(
              <div
                ref={popoverRef}
                className="fixed z-50 flex max-w-xs flex-wrap gap-1.5 rounded-lg border border-border bg-popover p-2.5 shadow-lg"
                style={(() => {
                  if (!dotsRef.current) return {};
                  const rect = dotsRef.current.getBoundingClientRect();
                  return { left: rect.left, top: rect.bottom + 4 };
                })()}
              >
                {tags.map((name) => (
                  <TagChip
                    key={name}
                    tag={resolveTag(name)}
                    size="sm"
                    onRemove={trashMode ? undefined : () => onRemoveTag(name)}
                  />
                ))}
              </div>,
              document.body,
            )}
        </div>
      )}

      {!trashMode && (
        <button
          type="button"
          onClick={onTogglePicker}
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-2 text-[11px] text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          <span className="hidden sm:inline">Add tag</span>
        </button>
      )}
      {pickerOpen && !trashMode && (
        <div className="relative">
          <TagPicker
            allTags={allTags}
            selected={tags}
            onToggle={onToggleTag}
            onCreateTag={onCreateTag}
            onClose={onClosePicker}
          />
        </div>
      )}
    </div>
  );
}
